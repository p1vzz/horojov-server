import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  getCollections,
  type BirthProfileDoc,
  type FullNatalCareerAnalysisDoc,
  type FullNatalCareerAnalysisPayloadDoc,
} from '../../db/mongo.js';
import type { ChartPromptPayload } from '../careerInsights.js';
import {
  generateFullNatalCareerAnalysis,
  getFullNatalAnalysisConfig,
} from '../fullNatalAnalysis.js';
import {
  buildMarketCareerContext,
  serializeMarketCareerPathsForPrompt,
  type MarketCareerContext,
} from '../marketCareerContext.js';
import {
  getOperationProgressSnapshot,
  startOperationProgress,
  type OperationProgressDefinition,
  type OperationProgressSnapshot,
} from '../operationProgress.js';

export const natalChartRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  birthDate: z
    .string()
    .trim()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/),
  birthTime: z
    .string()
    .trim()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  unknownTime: z.boolean().default(false),
  city: z.string().trim().min(2).max(160),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  country: z.string().trim().min(2).max(120).nullable().optional(),
  admin1: z.string().trim().min(1).max(120).nullable().optional(),
  currentJobTitle: z.string().trim().min(2).max(120).nullable().optional(),
});

const housePlanetSchema = z.object({
  name: z.string(),
  sign: z.string(),
  full_degree: z.number(),
  is_retro: z.union([z.string(), z.boolean()]).optional(),
});

const houseSchema = z.object({
  start_degree: z.number(),
  end_degree: z.number(),
  sign: z.string(),
  house_id: z.number(),
  planets: z.array(housePlanetSchema).optional(),
});

const aspectSchema = z.object({
  aspecting_planet: z.string(),
  aspected_planet: z.string(),
  type: z.string(),
  orb: z.number().optional(),
  diff: z.number().optional(),
});

export const westernChartSchema = z.object({
  houses: z.array(houseSchema),
  aspects: z.array(aspectSchema),
});

export const geoDetailsSchema = z.object({
  geonames: z.array(
    z.object({
      place_name: z.string().optional(),
      latitude: z.union([z.string(), z.number()]),
      longitude: z.union([z.string(), z.number()]),
      timezone_id: z.string().optional(),
    }),
  ),
});

export const timezoneSchema = z.object({
  timezone: z.number(),
});

export type NatalInput = z.infer<typeof natalChartRequestSchema>;
export type WesternChart = z.infer<typeof westernChartSchema>;
type AstrologyApiBody = Record<string, unknown>;

export const HOUSE_TYPE = "placidus";
export const MIN_CAREER_INSIGHTS = 3;
export const MAX_CAREER_INSIGHTS = 5;

const queryBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean()).default(false);

export const careerInsightsQuerySchema = z.object({
  tier: z.enum(["free", "premium"]).default("free"),
  regenerate: z.coerce.boolean().default(false),
});

export const discoverRolesQuerySchema = z.object({
  query: z.string().trim().max(80).default(""),
  limit: z.coerce.number().int().min(3).max(8).default(5),
  searchLimit: z.coerce.number().int().min(5).max(30).default(20),
  refresh: queryBooleanSchema,
  deferSearchScores: queryBooleanSchema,
  scoreSlug: z.string().trim().max(120).default(""),
  rankingMode: z.enum(["fit", "opportunity"]).default("fit"),
});

export const discoverRoleShortlistParamsSchema = z.object({
  slug: z.string().trim().min(1).max(120),
});

export const discoverRoleShortlistBodySchema = z.object({
  role: z.string().trim().min(1).max(120),
  domain: z.string().trim().min(1).max(120),
  scoreLabel: z.string().trim().max(48).nullable().default(null),
  scoreValue: z.number().finite().nullable().default(null),
  tags: z.array(z.string().trim().min(1).max(48)).max(6).default([]),
  market: z.record(z.string(), z.unknown()).nullable().default(null),
  detail: z.record(z.string(), z.unknown()).nullable().default(null),
  savedAt: z.string().trim().max(64).optional(),
});

export const discoverRoleCurrentJobBodySchema = z.object({
  title: z.string().trim().min(2).max(120),
});

export const aiSynergyHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  limit: z.coerce.number().int().min(1).max(90).default(30),
});

export const dailyTransitQuerySchema = z.object({
  includeAiSynergy: queryBooleanSchema,
});

export const morningBriefingQuerySchema = z.object({
  refresh: queryBooleanSchema,
});

export const careerVibePlanQuerySchema = z.object({
  refresh: queryBooleanSchema,
});

export const fullNatalAnalysisQuerySchema = z.object({
  cacheOnly: queryBooleanSchema,
});

function normalizeAstrologyBaseUrl(input: string) {
  const url = new URL(input);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath === "" || normalizedPath === "/") {
    url.pathname = "/v1";
  } else {
    url.pathname = normalizedPath;
  }
  return url.toString().replace(/\/+$/, "");
}

export function resolveAstrologyAuthHeaders(): Record<string, string> | null {
  const apiKey = env.ASTROLOGY_API_KEY?.trim();
  if (!apiKey) return null;

  if (apiKey.startsWith("ak-")) {
    return {
      "x-astrologyapi-key": apiKey,
    };
  }

  const userId = env.ASTROLOGY_USER_ID?.trim();
  if (!userId) return null;
  const auth = Buffer.from(`${userId}:${apiKey}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
  };
}

export async function callAstrologyApi<T>(
  path: string,
  body: AstrologyApiBody,
): Promise<{ status: number; data: T | null; text: string }> {
  const authHeaders = resolveAstrologyAuthHeaders();
  if (!authHeaders) {
    throw new Error("Astrology API credentials are not configured");
  }
  const baseUrl = normalizeAstrologyBaseUrl(env.ASTROLOGY_URL);

  const response = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "Accept-Language": "en",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });

  const text = await response.text();
  let parsed: T | null = null;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    parsed = null;
  }

  return { status: response.status, data: parsed, text };
}

export function parseBirthDate(input: string) {
  const [dayRaw, monthRaw, yearRaw] = input.split("/");
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year)
  ) {
    return null;
  }
  if (
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < 1900 ||
    year > 2100
  ) {
    return null;
  }
  return { day, month, year };
}

export function parseBirthTime(input: string | null, unknownTime: boolean) {
  if (unknownTime || !input) {
    return { hour: 12, min: 0, isApproximate: true };
  }

  const [hourRaw, minRaw] = input.split(":");
  const hour = Number(hourRaw);
  const min = Number(minRaw);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(min) ||
    hour < 0 ||
    hour > 23 ||
    min < 0 ||
    min > 59
  ) {
    return null;
  }
  return { hour, min, isApproximate: false };
}

export function toFloat(value: string | number) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildGeoQueryCandidates(cityInput: string) {
  const normalized = cityInput.trim();
  const byComma = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const candidates = [
    normalized,
    byComma[0],
    byComma.slice(0, 2).join(" "),
    byComma.join(" "),
  ].filter((value): value is string => !!value && value.length >= 2);
  return [...new Set(candidates)];
}

function normalizeCity(city: string) {
  return city.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeOptionalText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizePersonName(value: string | null | undefined) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeCurrentJobTitle(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length >= 2 ? normalized : null;
}

export function normalizeCoordinate(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(6));
}

export function buildProfileHash(input: NatalInput) {
  const latitude = normalizeCoordinate(input.latitude ?? null);
  const longitude = normalizeCoordinate(input.longitude ?? null);
  const normalized = {
    birthDate: input.birthDate.trim(),
    birthTime: input.birthTime ?? null,
    unknownTime: Boolean(input.unknownTime),
    city: normalizeCity(input.city),
    country: normalizeOptionalText(input.country),
    admin1: normalizeOptionalText(input.admin1),
    latitude,
    longitude,
    houseType: HOUSE_TYPE,
    provider: "astrologyapi-v1",
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

const BIRTH_PROFILE_EDIT_LOCK_BASE_DAYS = 1;
const BIRTH_PROFILE_EDIT_LOCK_MAX_DAYS = 30;
const BIRTH_PROFILE_EDIT_LOCK_MAX_LEVEL = 6;
const DAY_MS = 24 * 60 * 60 * 1000;

type BirthProfileEditLockDoc = Pick<
  BirthProfileDoc,
  "profileHash" | "birthEditLockDurationDays" | "birthEditLockedUntil" | "birthEditLockLevel"
>;

export type BirthProfileEditLockSnapshot = {
  lockedUntil: Date | null;
  retryAfterSeconds: number | null;
  lockLevel: number;
  durationDays: number | null;
};

export type BirthProfileEditPolicy =
  | {
      changed: false;
      blocked: false;
      lock: BirthProfileEditLockSnapshot;
      nextLock: null;
    }
  | {
      changed: true;
      blocked: true;
      lock: BirthProfileEditLockSnapshot;
      nextLock: null;
    }
  | {
      changed: true;
      blocked: false;
      lock: BirthProfileEditLockSnapshot;
      nextLock: {
        lockedUntil: Date;
        lockLevel: number;
        durationDays: number;
      };
    };

function normalizeBirthEditLockLevel(value: unknown) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
  return Math.max(0, Math.min(BIRTH_PROFILE_EDIT_LOCK_MAX_LEVEL, numeric));
}

function normalizeBirthEditLockDurationDays(value: unknown) {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : null;
  if (numeric === null || numeric < 1) return null;
  return Math.min(BIRTH_PROFILE_EDIT_LOCK_MAX_DAYS, numeric);
}

export function resolveBirthProfileEditLockDurationDays(lockLevel: number) {
  const normalizedLevel = Math.max(1, Math.min(BIRTH_PROFILE_EDIT_LOCK_MAX_LEVEL, Math.trunc(lockLevel)));
  const exponentialDays = BIRTH_PROFILE_EDIT_LOCK_BASE_DAYS * 2 ** (normalizedLevel - 1);
  return Math.min(BIRTH_PROFILE_EDIT_LOCK_MAX_DAYS, exponentialDays);
}

export function buildBirthProfileEditLockSnapshot(
  input: Partial<BirthProfileEditLockDoc> | null | undefined,
  now = new Date(),
): BirthProfileEditLockSnapshot {
  const lockedUntil =
    input?.birthEditLockedUntil instanceof Date && Number.isFinite(input.birthEditLockedUntil.getTime())
      ? input.birthEditLockedUntil
      : null;
  const futureLockedUntil = lockedUntil && lockedUntil.getTime() > now.getTime() ? lockedUntil : null;
  return {
    lockedUntil: futureLockedUntil,
    retryAfterSeconds: futureLockedUntil
      ? Math.max(1, Math.ceil((futureLockedUntil.getTime() - now.getTime()) / 1000))
      : null,
    lockLevel: normalizeBirthEditLockLevel(input?.birthEditLockLevel),
    durationDays: normalizeBirthEditLockDurationDays(input?.birthEditLockDurationDays),
  };
}

export function serializeBirthProfileEditLock(snapshot: BirthProfileEditLockSnapshot) {
  return {
    lockedUntil: snapshot.lockedUntil ? snapshot.lockedUntil.toISOString() : null,
    retryAfterSeconds: snapshot.retryAfterSeconds,
    lockLevel: snapshot.lockLevel,
    durationDays: snapshot.durationDays,
  };
}

export function resolveBirthProfileEditPolicy(
  existingProfile: Partial<BirthProfileEditLockDoc> | null | undefined,
  nextProfileHash: string,
  now = new Date(),
): BirthProfileEditPolicy {
  const currentLock = buildBirthProfileEditLockSnapshot(existingProfile, now);
  const currentProfileHash =
    typeof existingProfile?.profileHash === "string" && existingProfile.profileHash.trim().length > 0
      ? existingProfile.profileHash
      : null;

  if (!currentProfileHash || currentProfileHash === nextProfileHash) {
    return {
      changed: false,
      blocked: false,
      lock: currentLock,
      nextLock: null,
    };
  }

  if (currentLock.lockedUntil) {
    return {
      changed: true,
      blocked: true,
      lock: currentLock,
      nextLock: null,
    };
  }

  const nextLockLevel = Math.min(currentLock.lockLevel + 1, BIRTH_PROFILE_EDIT_LOCK_MAX_LEVEL);
  const durationDays = resolveBirthProfileEditLockDurationDays(nextLockLevel);
  const lockedUntil = new Date(now.getTime() + durationDays * DAY_MS);

  return {
    changed: true,
    blocked: false,
    lock: {
      lockedUntil,
      retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000)),
      lockLevel: nextLockLevel,
      durationDays,
    },
    nextLock: {
      lockedUntil,
      lockLevel: nextLockLevel,
      durationDays,
    },
  };
}

export async function upsertBirthProfile(
  userId: ObjectId,
  input: NatalInput,
  options?: {
    editLock?: {
      lockedUntil: Date;
      lockLevel: number;
      durationDays: number;
    } | null;
    currentJobChanged?: boolean;
    touchUpdatedAt?: boolean;
  },
) {
  const collections = await getCollections();
  const now = new Date();
  const profileHash = buildProfileHash(input);
  const nextSet: Partial<BirthProfileDoc> = {
    name: normalizePersonName(input.name),
    birthDate: input.birthDate,
    birthTime: input.birthTime,
    unknownTime: input.unknownTime,
    city: input.city,
    latitude: normalizeCoordinate(input.latitude ?? null),
    longitude: normalizeCoordinate(input.longitude ?? null),
    country: normalizeOptionalText(input.country),
    admin1: normalizeOptionalText(input.admin1),
    normalizedCity: normalizeCity(input.city),
    profileHash,
  };
  if (options?.touchUpdatedAt !== false) {
    nextSet.updatedAt = now;
  }
  if (input.currentJobTitle !== undefined) {
    nextSet.currentJobTitle = normalizeCurrentJobTitle(input.currentJobTitle);
    if (options?.currentJobChanged ?? true) {
      nextSet.currentJobUpdatedAt = nextSet.currentJobTitle ? now : null;
    }
  }
  if (options?.editLock) {
    nextSet.birthEditLockLevel = options.editLock.lockLevel;
    nextSet.birthEditLockDurationDays = options.editLock.durationDays;
    nextSet.birthEditLockedUntil = options.editLock.lockedUntil;
    nextSet.birthEditLastChangedAt = now;
  }
  await collections.birthProfiles.updateOne(
    { userId },
    {
      $set: nextSet,
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true },
  );
  return profileHash;
}

function isBodyEmpty(value: unknown) {
  return (
    !value ||
    typeof value !== "object" ||
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

export async function resolveNatalInputForUser(
  userId: ObjectId,
  body: unknown,
) {
  if (!isBodyEmpty(body)) {
    const parsed = natalChartRequestSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false as const,
        code: 400 as const,
        details: parsed.error.flatten().fieldErrors,
      };
    }
    const profileHash = await upsertBirthProfile(userId, parsed.data);
    return { ok: true as const, input: parsed.data, profileHash };
  }

  const collections = await getCollections();
  const stored = await collections.birthProfiles.findOne({ userId });
  if (!stored) {
    return { ok: false as const, code: 404 as const, details: null };
  }

  return {
    ok: true as const,
    input: {
      name: typeof stored.name === "string" ? stored.name : "",
      birthDate: stored.birthDate,
      birthTime: stored.birthTime,
      unknownTime: stored.unknownTime,
      city: stored.city,
      latitude: typeof stored.latitude === "number" ? stored.latitude : null,
      longitude: typeof stored.longitude === "number" ? stored.longitude : null,
      country: stored.country ?? null,
      admin1: stored.admin1 ?? null,
    } satisfies NatalInput,
    profileHash: stored.profileHash,
  };
}

function parseRetro(value: string | boolean | undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "retrograde" ||
    normalized === "retro" ||
    normalized === "r" ||
    normalized === "rx"
  );
}

export function buildChartPromptPayload(
  chart: WesternChart,
): ChartPromptPayload {
  const placements = chart.houses
    .flatMap((house) =>
      (house.planets ?? []).map((planet) => ({
        planet: planet.name,
        sign: planet.sign,
        house: house.house_id,
        fullDegree: planet.full_degree,
        retrograde: parseRetro(planet.is_retro),
      })),
    )
    .sort((a, b) => a.fullDegree - b.fullDegree);

  const aspects = chart.aspects
    .map((aspect) => ({
      from: aspect.aspecting_planet,
      to: aspect.aspected_planet,
      type: aspect.type,
      orb: typeof aspect.orb === "number" ? aspect.orb : null,
    }))
    .slice(0, 40);

  const ascSign =
    chart.houses.find((house) => house.house_id === 1)?.sign ?? "Unknown";
  const mcSign =
    chart.houses.find((house) => house.house_id === 10)?.sign ?? "Unknown";

  return {
    ascSign,
    mcSign,
    placements,
    aspects,
  };
}

export type FullNatalAnalysisRouteResponse = {
  cached: boolean;
  model: string;
  promptVersion: string;
  narrativeSource: "llm";
  generatedAt: string;
  profileUpdatedAt: string;
  profileChangeNotice: {
    profileUpdatedAt: string;
    expiresAt: string;
  } | null;
  marketContext: Pick<MarketCareerContext, "algorithmVersion" | "generatedAt" | "location" | "sourceNote"> | null;
  marketCareerPaths: MarketCareerContext["marketCareerPaths"];
  analysis: FullNatalCareerAnalysisPayloadDoc;
};

const PROFILE_CHANGE_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;
const fullNatalAnalysisInFlight = new Map<string, Promise<FullNatalAnalysisRouteResponse>>();

export const FULL_NATAL_ANALYSIS_PROGRESS_DEFINITION: OperationProgressDefinition = {
  operation: 'full_natal_career_analysis',
  title: 'Building Career Blueprint',
  subtitle: 'Preparing your one-time career report from your birth details.',
  stages: [
    {
      key: 'preparing_profile',
      title: 'Preparing your birth details',
      detail: 'We are checking the details needed to build your report.',
    },
    {
      key: 'reading_chart',
      title: 'Reading your natal chart',
      detail: 'We are turning your chart into career signals.',
    },
    {
      key: 'building_blueprint',
      title: 'Building your career blueprint',
      detail: 'We are shaping the long-form report and career map.',
    },
    {
      key: 'backup_route',
      title: 'Taking a backup route',
      detail: 'The first path did not finish cleanly, so we are using a backup path. This can take a little longer.',
    },
    {
      key: 'validating_report',
      title: 'Checking the finished report',
      detail: 'We are making sure the report is complete before saving it.',
    },
  ],
};

function buildFullNatalAnalysisOperationSubjectKey(input: {
  userId: ObjectId;
  profileHash: string;
  promptVersion: string;
}) {
  return `${input.userId.toHexString()}:${input.profileHash}:${input.promptVersion}`;
}

export function resolveFullNatalProfileChangeNotice(input: {
  profileUpdatedAt: Date;
  previousReport: Pick<FullNatalCareerAnalysisDoc, "generatedAt"> | null;
  now?: Date;
}): FullNatalAnalysisRouteResponse["profileChangeNotice"] {
  const now = input.now ?? new Date();
  const expiresAt = new Date(input.profileUpdatedAt.getTime() + PROFILE_CHANGE_NOTICE_MS);
  if (!input.previousReport || now.getTime() > expiresAt.getTime()) {
    return null;
  }
  if (input.previousReport.generatedAt.getTime() >= input.profileUpdatedAt.getTime()) {
    return null;
  }
  return {
    profileUpdatedAt: input.profileUpdatedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
  };
}

export function serializeFullNatalAnalysisGeneration(
  lockKey: string,
  producer: () => Promise<FullNatalAnalysisRouteResponse>,
) {
  const inFlight = fullNatalAnalysisInFlight.get(lockKey);
  if (inFlight) return inFlight;

  const next = producer().finally(() => {
    fullNatalAnalysisInFlight.delete(lockKey);
  });
  fullNatalAnalysisInFlight.set(lockKey, next);
  return next;
}

function serializeMarketCareerContextSummary(context: MarketCareerContext | null): FullNatalAnalysisRouteResponse["marketContext"] {
  if (!context) return null;
  return {
    algorithmVersion: context.algorithmVersion,
    generatedAt: context.generatedAt,
    location: context.location,
    sourceNote: context.sourceNote,
  };
}

export async function getFullNatalAnalysisProgressForUser(input: {
  userId: ObjectId;
}): Promise<OperationProgressSnapshot> {
  const collections = await getCollections();
  const profile = await collections.birthProfiles.findOne(
    { userId: input.userId },
    { projection: { profileHash: 1 } },
  );
  if (!profile) {
    return getOperationProgressSnapshot(
      FULL_NATAL_ANALYSIS_PROGRESS_DEFINITION,
      `${input.userId.toHexString()}:missing_profile`,
    );
  }

  const config = getFullNatalAnalysisConfig();
  return getOperationProgressSnapshot(
    FULL_NATAL_ANALYSIS_PROGRESS_DEFINITION,
    buildFullNatalAnalysisOperationSubjectKey({
      userId: input.userId,
      profileHash: profile.profileHash,
      promptVersion: config.promptVersion,
    }),
  );
}

export async function getOrCreateFullNatalAnalysisForUser(input: {
  userId: ObjectId;
  cacheOnly?: boolean;
  logger: FastifyBaseLogger;
}): Promise<FullNatalAnalysisRouteResponse | null> {
  const collections = await getCollections();
  const profile = await collections.birthProfiles.findOne({
    userId: input.userId,
  });
  if (!profile) {
    throw new Error("Birth profile not found");
  }
  const { profileHash } = profile;

  const config = getFullNatalAnalysisConfig();
  const buildProfileChangeNotice = async () => {
    const previousReport = await collections.fullNatalCareerAnalysis.findOne(
      {
        userId: input.userId,
        profileHash: { $ne: profileHash },
      },
      { sort: { generatedAt: -1 }, projection: { generatedAt: 1 } },
    );
    return resolveFullNatalProfileChangeNotice({
      profileUpdatedAt: profile.updatedAt,
      previousReport,
    });
  };
  const loadMarketCareerContext = async (chartDoc?: { chart?: unknown } | null) => {
    const natalChart = chartDoc ?? await collections.natalCharts.findOne(
      {
        userId: input.userId,
        profileHash,
      },
      { projection: { chart: 1 } },
    );
    if (!natalChart) return null;

    const parsedChart = westernChartSchema.safeParse(natalChart.chart);
    if (!parsedChart.success) {
      input.logger.error(
        { issues: parsedChart.error.issues },
        "cached natal chart validation failed for full analysis market context",
      );
      return null;
    }

    return buildMarketCareerContext({
      chartPayload: buildChartPromptPayload(parsedChart.data),
      logger: input.logger,
      limit: 5,
    });
  };

  const cached = await collections.fullNatalCareerAnalysis.findOne(
    {
      userId: input.userId,
      profileHash,
      promptVersion: config.promptVersion,
      narrativeSource: "llm",
    },
    { sort: { generatedAt: -1 } },
  );

  if (cached) {
    const marketCareerContext = await loadMarketCareerContext();
    return {
      cached: true,
      model: cached.model,
      promptVersion: cached.promptVersion,
      narrativeSource: "llm",
      generatedAt: cached.generatedAt.toISOString(),
      profileUpdatedAt: profile.updatedAt.toISOString(),
      profileChangeNotice: await buildProfileChangeNotice(),
      marketContext: serializeMarketCareerContextSummary(marketCareerContext),
      marketCareerPaths: marketCareerContext?.marketCareerPaths ?? [],
      analysis: cached.analysis,
    };
  }

  if (input.cacheOnly) {
    return null;
  }

  const lockKey = buildFullNatalAnalysisOperationSubjectKey({
    userId: input.userId,
    profileHash,
    promptVersion: config.promptVersion,
  });
  return serializeFullNatalAnalysisGeneration(lockKey, async () => {
    const progress = startOperationProgress(FULL_NATAL_ANALYSIS_PROGRESS_DEFINITION, lockKey);
    progress.setStage('preparing_profile');
    try {
      progress.setStage('reading_chart');
      const [natalChart, latestAiSynergy, latestCareerInsight] = await Promise.all([
        collections.natalCharts.findOne(
          {
            userId: input.userId,
            profileHash,
          },
          { projection: { chart: 1 } },
        ),
        collections.aiSynergyDaily.findOne(
          {
            userId: input.userId,
            profileHash,
          },
          { sort: { dateKey: -1, updatedAt: -1 }, projection: { score: 1, band: 1 } },
        ),
        collections.careerInsights.findOne(
          {
            userId: input.userId,
            profileHash,
            tier: "premium",
          },
          { sort: { generatedAt: -1 }, projection: { summary: 1 } },
        ),
      ]);

      if (!natalChart) {
        throw new Error("Natal chart not found. Generate chart first.");
      }

      const parsedChart = westernChartSchema.safeParse(natalChart.chart);
      if (!parsedChart.success) {
        input.logger.error(
          { issues: parsedChart.error.issues },
          "cached natal chart validation failed for full analysis",
        );
        throw new Error("Cached natal chart has invalid format");
      }
      const marketCareerContext = await loadMarketCareerContext(natalChart);

      progress.setStage('building_blueprint');
      const generated = await generateFullNatalCareerAnalysis({
        chartPayload: buildChartPromptPayload(parsedChart.data),
        context: {
          aiSynergyScore: latestAiSynergy?.score ?? null,
          aiSynergyBand: latestAiSynergy?.band ?? null,
          careerInsightsSummary: latestCareerInsight?.summary ?? null,
          marketCareerPaths: serializeMarketCareerPathsForPrompt(marketCareerContext?.marketCareerPaths ?? []),
          marketSourceNote: marketCareerContext?.sourceNote ?? null,
        },
        logger: input.logger,
        progress,
      });

      const now = new Date();
      await collections.fullNatalCareerAnalysis.updateOne(
        {
          userId: input.userId,
          profileHash,
          promptVersion: generated.promptVersion,
        },
        {
          $set: {
            analysis: generated.analysis,
            model: generated.model,
            narrativeSource: generated.narrativeSource,
            generatedAt: now,
            updatedAt: now,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            createdAt: now,
          },
        },
        { upsert: true },
      );

      progress.complete();
      return {
        cached: false,
        model: generated.model,
        promptVersion: generated.promptVersion,
        narrativeSource: generated.narrativeSource,
        generatedAt: now.toISOString(),
        profileUpdatedAt: profile.updatedAt.toISOString(),
        profileChangeNotice: await buildProfileChangeNotice(),
        marketContext: serializeMarketCareerContextSummary(marketCareerContext),
        marketCareerPaths: marketCareerContext?.marketCareerPaths ?? [],
        analysis: generated.analysis,
      };
    } catch (error) {
      progress.fail();
      throw error;
    }
  });
}
