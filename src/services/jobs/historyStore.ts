import { ObjectId } from 'mongodb';
import { getCollections, type JobScanResultDoc } from '../../db/mongo.js';

export type JobScanHistoryMeta = {
  source: string;
  cached: boolean;
  provider: string | null;
};

export type JobScanHistoryEntryPayload = {
  url: string;
  analysis: Record<string, unknown>;
  meta: JobScanHistoryMeta;
  savedAt?: string;
};

type JobScanHistoryOrigin = 'url' | 'screenshots';
type JobScanDepth = 'lite' | 'full';
type JobScanDepthRequest = 'auto' | JobScanDepth;

type UpsertJobScanHistoryInput = {
  userId: ObjectId;
  url: string;
  analysis: Record<string, unknown>;
  meta: JobScanHistoryMeta;
  savedAt?: Date;
  origin: JobScanHistoryOrigin;
  canonicalUrlHash?: string | null;
  jobContentHash?: string | null;
  profileHash?: string | null;
};

type SyncJobScanHistoryEntriesInput = {
  userId: ObjectId;
  entries: JobScanHistoryEntryPayload[];
};

function asRecord(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return null;
  }
  return input as Record<string, unknown>;
}

function asString(input: unknown, fallback = '') {
  return typeof input === 'string' ? input : fallback;
}

function asNullableString(input: unknown) {
  return typeof input === 'string' ? input : null;
}

function asBoolean(input: unknown, fallback = false) {
  return typeof input === 'boolean' ? input : fallback;
}

function normalizeJobScanHistoryUrlKey(rawUrl: string) {
  const trimmed = rawUrl.trim();
  if (!trimmed) return '';

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    parsed.hash = '';
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.pathname = parsed.pathname.replace(/\/{2,}/g, '/');
    if (parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    }
    return parsed.toString();
  } catch {
    return trimmed.toLowerCase();
  }
}

function resolveJobScanHistoryKey(url: string, analysisId: string) {
  const normalizedUrl = normalizeJobScanHistoryUrlKey(url);
  return normalizedUrl.length > 0 ? normalizedUrl : `analysis:${analysisId}`;
}

function normalizeSavedAt(input?: Date | string) {
  if (input instanceof Date && Number.isFinite(input.getTime())) {
    return input;
  }
  if (typeof input === 'string') {
    const parsed = Date.parse(input);
    if (Number.isFinite(parsed)) {
      return new Date(parsed);
    }
  }
  return new Date();
}

function normalizeScanDepth(input: unknown): JobScanDepth {
  return input === 'lite' ? 'lite' : 'full';
}

function normalizeRequestedScanDepth(input: unknown): JobScanDepthRequest {
  return input === 'lite' || input === 'full' || input === 'auto'
    ? input
    : 'auto';
}

function inferJobScanHistoryOrigin(entry: JobScanHistoryEntryPayload) {
  const analysis = asRecord(entry.analysis);
  if (analysis?.screenshot && typeof analysis.screenshot === 'object') {
    return 'screenshots' as const;
  }
  const normalizedUrl = normalizeJobScanHistoryUrlKey(entry.url);
  if (normalizedUrl === 'screenshot upload') {
    return 'screenshots' as const;
  }
  return 'url' as const;
}

function buildJobScanResultDoc(
  input: UpsertJobScanHistoryInput,
  savedAt: Date,
): Omit<JobScanResultDoc, '_id' | 'createdAt'> {
  const analysisId = asString(
    input.analysis.analysisId,
    new ObjectId().toHexString(),
  );

  return {
    userId: input.userId,
    historyKey: resolveJobScanHistoryKey(input.url, analysisId),
    origin: input.origin,
    url: input.url,
    canonicalUrlHash: input.canonicalUrlHash ?? null,
    jobContentHash: input.jobContentHash ?? null,
    profileHash: input.profileHash ?? null,
    analysisId,
    scanDepth: normalizeScanDepth(input.analysis.scanDepth),
    requestedScanDepth: normalizeRequestedScanDepth(
      input.analysis.requestedScanDepth,
    ),
    providerUsed: asNullableString(input.analysis.providerUsed),
    resultSnapshot: input.analysis,
    meta: {
      source: input.meta.source.trim().length > 0 ? input.meta.source : 'unknown',
      cached: input.meta.cached,
      provider: input.meta.provider,
    },
    updatedAt: savedAt,
  };
}

export async function upsertJobScanHistory(input: UpsertJobScanHistoryInput) {
  const collections = await getCollections();
  const savedAt = normalizeSavedAt(input.savedAt);
  const doc = buildJobScanResultDoc(input, savedAt);

  const existing = await collections.jobScanResults.findOne(
    {
      userId: input.userId,
      historyKey: doc.historyKey,
    },
    { projection: { updatedAt: 1 } },
  );

  if (existing && existing.updatedAt.getTime() > savedAt.getTime()) {
    return false;
  }

  await collections.jobScanResults.updateOne(
    {
      userId: input.userId,
      historyKey: doc.historyKey,
    },
    {
      $set: doc,
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: savedAt,
      },
    },
    { upsert: true },
  );

  return true;
}

export async function listJobScanHistory(input: {
  userId: ObjectId;
  limit?: number;
}): Promise<JobScanHistoryEntryPayload[]> {
  const collections = await getCollections();
  const limit = Math.max(1, Math.min(input.limit ?? 8, 20));
  const docs = await collections.jobScanResults
    .find({ userId: input.userId })
    .sort({ updatedAt: -1 })
    .limit(limit)
    .toArray();

  return docs.map((doc) => ({
    url: doc.url,
    analysis: doc.resultSnapshot,
    meta: doc.meta,
    savedAt: doc.updatedAt.toISOString(),
  }));
}

export async function syncJobScanHistoryEntries(
  input: SyncJobScanHistoryEntriesInput,
) {
  let importedCount = 0;

  for (const entry of input.entries) {
    const analysis = asRecord(entry.analysis);
    if (!analysis) {
      continue;
    }

    const didWrite = await upsertJobScanHistory({
      userId: input.userId,
      url: entry.url,
      analysis,
      meta: {
        source:
          entry.meta?.source && entry.meta.source.trim().length > 0
            ? entry.meta.source
            : 'unknown',
        cached: asBoolean(entry.meta?.cached),
        provider: asNullableString(entry.meta?.provider),
      },
      savedAt: normalizeSavedAt(entry.savedAt),
      origin: inferJobScanHistoryOrigin(entry),
      canonicalUrlHash: null,
      jobContentHash: null,
      profileHash: null,
    });

    if (didWrite) {
      importedCount += 1;
    }
  }

  return { importedCount };
}
