import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { env } from '../../config/env.js';
import { getCollections } from '../../db/mongo.js';
import { authenticateByAuthorizationHeader } from '../auth.js';
import {
  buildDeterministicJobAnalysis,
  extractJobFeatures,
  getJobAnalysisVersions,
} from '../jobAnalysis.js';
import {
  buildParsedCacheExpiry,
  buildRawCacheExpiry,
  buildRawHtmlArtifactExpiry,
  isCacheValid,
} from '../jobCachePolicy.js';
import {
  buildNegativeCacheExpiry,
  classifyNegativeCacheStatus,
  getNegativeCacheHttpStatus,
  NEGATIVE_CACHE_ERROR_TEXTS,
} from '../jobNegativeCache.js';
import {
  fetchJobWithProviderFallback,
  isLikelyChallengeJobPayload,
  type NormalizedJobPayload,
} from '../jobProviders.js';
import type { OccupationInsightResponse } from '../marketData/types.js';
import { validateAndCanonicalizeJobUrl } from '../jobUrl.js';
import {
  getCurrentJobUsageLimitSnapshot,
  incrementUsageAfterSuccessfulScan,
  resolveJobScanDepth,
  resolveUserUsagePlan,
  type JobScanDepth,
  type JobUsageLimitSnapshot,
  type UsageLimitState,
} from '../jobUsageLimits.js';
import {
  compactProviderAttempts,
  extractRawHtmlArtifact,
  fallbackJobFromText,
  getValidationErrorMessage,
  parseNormalizedJobPayload,
  statusCodeForValidationCode,
  stripRawHtmlFromPayload,
} from './common.js';
import { upsertJobScanHistory } from './historyStore.js';
import { buildJobMarketInsight } from './marketEnrichment.js';
import { analyzeSchema } from './schemas.js';

function asStringArray(input: unknown, maxItems: number) {
  if (!Array.isArray(input)) return [];
  return input
    .filter((entry): entry is string => typeof entry === "string")
    .slice(0, maxItems);
}

export function buildCachedJobAnalyzeResponse(input: {
  analysisId: string;
  providerUsed: string | null;
  rawCacheHit: boolean;
  parsedCacheHit: boolean;
  plan: 'free' | 'premium';
  limit: UsageLimitState;
  limits: JobUsageLimitSnapshot;
  market: OccupationInsightResponse | null;
  versions: {
    parserVersion: string;
    rubricVersion: string;
    modelVersion: string;
  };
  cachedResult: Record<string, unknown>;
  parsedFeaturesObject: Record<string, unknown>;
  normalizedJob: NormalizedJobPayload;
}) {
  const descriptors = asStringArray(input.cachedResult.descriptors, 8);

  return {
    analysisId: input.analysisId,
    status: "done",
    scanDepth: "full",
    requestedScanDepth: "full",
    providerUsed: input.providerUsed,
    cached: true,
    cache: {
      raw: input.rawCacheHit,
      parsed: input.parsedCacheHit,
      analysis: true,
    },
    usage: {
      plan: input.plan,
      depth: "full",
      incremented: false,
      limit: input.limit,
      limits: input.limits,
    },
    versions: input.versions,
    scores: input.cachedResult.scores ?? null,
    breakdown: Array.isArray(input.cachedResult.breakdown)
      ? input.cachedResult.breakdown
      : [],
    jobSummary:
      typeof input.cachedResult.jobSummary === "string"
        ? input.cachedResult.jobSummary
        : "",
    tags: asStringArray(input.cachedResult.tags, 40),
    descriptors:
      descriptors.length > 0
        ? descriptors
        : asStringArray(input.parsedFeaturesObject.descriptors, 8),
    market: input.market,
    job: {
      title: input.normalizedJob.title,
      company: input.normalizedJob.company,
      location: input.normalizedJob.location,
      salaryText: input.normalizedJob.salaryText,
      employmentType: input.normalizedJob.employmentType,
      source: input.normalizedJob.source,
    },
  };
}

export async function handleJobAnalyze(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = await authenticateByAuthorizationHeader(
    request.headers.authorization,
  );
  if (!auth) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const parse = analyzeSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.code(400).send({
      error: "Invalid request payload",
      details: parse.error.flatten().fieldErrors,
    });
  }

  const validated = validateAndCanonicalizeJobUrl(parse.data.url);
  if (!validated.ok) {
    return reply.code(statusCodeForValidationCode(validated.code)).send({
      error: getValidationErrorMessage(validated.code, validated.message),
      code: validated.code,
    });
  }

  const now = new Date();
  const versions = getJobAnalysisVersions();
  const collections = await getCollections();
  const canonical = validated.data;
  let rawDocCandidate = await collections.jobsRaw.findOne({
    canonicalUrlHash: canonical.canonicalUrlHash,
  });
  let rawDoc =
    rawDocCandidate && isCacheValid(rawDocCandidate.expiresAt, now)
      ? rawDocCandidate
      : null;

  if (rawDoc) {
    const normalizedFromRaw = parseNormalizedJobPayload(rawDoc.normalizedJob);
    if (isLikelyChallengeJobPayload(normalizedFromRaw)) {
      request.log.warn(
        {
          source: canonical.source,
          canonicalUrlHash: canonical.canonicalUrlHash,
          title: normalizedFromRaw?.title ?? null,
        },
        "invalidating cached challenge payload before analyze",
      );

      await Promise.all([
        collections.jobsRaw.deleteOne({
          canonicalUrlHash: canonical.canonicalUrlHash,
        }),
        collections.jobRawArtifacts.deleteOne({
          canonicalUrlHash: canonical.canonicalUrlHash,
        }),
        collections.jobsParsed.deleteMany({
          canonicalUrlHash: canonical.canonicalUrlHash,
        }),
        collections.jobAnalyses.deleteMany({
          canonicalUrlHash: canonical.canonicalUrlHash,
        }),
        collections.jobFetchNegativeCache.deleteOne({
          canonicalUrlHash: canonical.canonicalUrlHash,
        }),
      ]);

      rawDocCandidate = null;
      rawDoc = null;
    }
  }

  const plan = resolveUserUsagePlan(auth.user);
  let selectedScanDepth: JobScanDepth | null = null;
  let selectedLimit: UsageLimitState | null = null;
  let selectedLimits: JobUsageLimitSnapshot | null = null;
  const negativeCacheCandidate =
    rawDoc === null
      ? await collections.jobFetchNegativeCache.findOne({
          canonicalUrlHash: canonical.canonicalUrlHash,
        })
      : null;
  const activeNegativeCache =
    negativeCacheCandidate &&
    isCacheValid(negativeCacheCandidate.expiresAt, now)
      ? negativeCacheCandidate
      : null;

  if (activeNegativeCache) {
    return reply
      .code(getNegativeCacheHttpStatus(activeNegativeCache.status))
      .send({
        error:
          activeNegativeCache.message ||
          NEGATIVE_CACHE_ERROR_TEXTS[activeNegativeCache.status],
        code: activeNegativeCache.status,
        retryAt: activeNegativeCache.expiresAt.toISOString(),
      });
  }

  let providerUsed = rawDoc?.provider ?? null;
  let providerAttempts: ReturnType<typeof compactProviderAttempts> = [];
  const rawCacheHit = rawDoc !== null;
  let usageIncremented = false;

  if (!rawDoc) {
    const limits = await getCurrentJobUsageLimitSnapshot({
      userId: auth.user._id,
      plan,
      now,
    });
    const depthResolution = resolveJobScanDepth({
      limits,
      requestedDepth: parse.data.scanDepth,
    });
    if (!depthResolution.canProceed) {
      return reply.code(429).send({
        error: "Parse limit reached",
        code: "usage_limit_reached",
        scanDepth: depthResolution.depth,
        limit: depthResolution.limit,
        limits,
      });
    }
    selectedScanDepth = depthResolution.depth;
    selectedLimit = depthResolution.limit;
    selectedLimits = limits;

    const fetched = await fetchJobWithProviderFallback({
      canonical,
      log: request.log,
    });

    if (!fetched.ok) {
      const negativeStatus = classifyNegativeCacheStatus(fetched.attempts);
      if (negativeStatus) {
        const negativeExpiresAt = buildNegativeCacheExpiry(negativeStatus, now);
        const negativeMessage = NEGATIVE_CACHE_ERROR_TEXTS[negativeStatus];

        await collections.jobFetchNegativeCache.updateOne(
          { canonicalUrlHash: canonical.canonicalUrlHash },
          {
            $set: {
              source: canonical.source,
              canonicalUrlHash: canonical.canonicalUrlHash,
              status: negativeStatus,
              message: negativeMessage,
              details: {
                attempts: compactProviderAttempts(fetched.attempts),
              },
              updatedAt: now,
              expiresAt: negativeExpiresAt,
            },
            $setOnInsert: {
              _id: new ObjectId(),
              createdAt: now,
            },
          },
          { upsert: true },
        );

        return reply.code(getNegativeCacheHttpStatus(negativeStatus)).send({
          error: negativeMessage,
          code: negativeStatus,
          retryAt: negativeExpiresAt.toISOString(),
          attempts: compactProviderAttempts(fetched.attempts),
        });
      }

      return reply.code(502).send({
        error: fetched.message,
        code: fetched.code,
        attempts: compactProviderAttempts(fetched.attempts),
      });
    }

    providerUsed = fetched.providerUsed;
    providerAttempts = compactProviderAttempts(fetched.attempts);
    const expiresAt = buildRawCacheExpiry(now);
    const sanitizedRawPayload = stripRawHtmlFromPayload(fetched.rawPayload);

    const persistedRaw = await collections.jobsRaw.findOneAndUpdate(
      { canonicalUrlHash: canonical.canonicalUrlHash },
      {
        $set: {
          source: canonical.source,
          host: canonical.host,
          canonicalUrl: canonical.canonicalUrl,
          canonicalUrlHash: canonical.canonicalUrlHash,
          sourceJobId: canonical.sourceJobId,
          provider: fetched.providerUsed,
          providerRequestId: fetched.providerRequestId,
          providerMeta: fetched.providerMeta,
          rawPayload: sanitizedRawPayload,
          normalizedText: fetched.normalizedText,
          normalizedJob: fetched.normalized,
          jobContentHash: fetched.jobContentHash,
          fetchedAt: now,
          updatedAt: now,
          expiresAt,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    if (env.JOB_SCRAPER_STORE_RAW_HTML) {
      const rawArtifact = extractRawHtmlArtifact(fetched.rawPayload);
      if (rawArtifact) {
        const artifactExpiresAt = buildRawHtmlArtifactExpiry(now);
        await collections.jobRawArtifacts.updateOne(
          { canonicalUrlHash: canonical.canonicalUrlHash },
          {
            $set: {
              source: canonical.source,
              canonicalUrlHash: canonical.canonicalUrlHash,
              provider: fetched.providerUsed,
              providerRequestId: fetched.providerRequestId,
              providerMeta: fetched.providerMeta,
              statusCode: rawArtifact.statusCode,
              finalUrl: rawArtifact.finalUrl,
              title: rawArtifact.title,
              html: rawArtifact.html,
              fetchedAt: now,
              updatedAt: now,
              expiresAt: artifactExpiresAt,
            },
            $setOnInsert: {
              _id: new ObjectId(),
              createdAt: now,
            },
          },
          { upsert: true },
        );
      }
    } else {
      await collections.jobRawArtifacts.deleteOne({
        canonicalUrlHash: canonical.canonicalUrlHash,
      });
    }

    rawDoc =
      persistedRaw && isCacheValid(persistedRaw.expiresAt, now)
        ? persistedRaw
        : null;
    if (!rawDoc) {
      return reply
        .code(502)
        .send({ error: "Unable to persist parsed vacancy payload" });
    }

    await Promise.all([
      collections.jobFetchNegativeCache.deleteOne({
        canonicalUrlHash: canonical.canonicalUrlHash,
      }),
    ]);
  }

  if (!rawDoc) {
    return reply.code(502).send({ error: "Raw vacancy cache is unavailable" });
  }

  const normalizedFromCache = parseNormalizedJobPayload(rawDoc.normalizedJob);
  const normalizedJob =
    normalizedFromCache ??
    fallbackJobFromText({
      source: canonical.source,
      canonicalUrl: canonical.canonicalUrl,
      sourceJobId: canonical.sourceJobId,
      normalizedText: rawDoc.normalizedText,
    });

  const parsedDocCandidate = await collections.jobsParsed.findOne({
    jobContentHash: rawDoc.jobContentHash,
    parserVersion: versions.parserVersion,
  });
  let parsedDoc =
    parsedDocCandidate && isCacheValid(parsedDocCandidate.expiresAt, now)
      ? parsedDocCandidate
      : null;
  let parsedCacheHit = parsedDoc !== null;

  if (!parsedDoc) {
    const parsedFeatures = extractJobFeatures(normalizedJob);
    const expiresAt = buildParsedCacheExpiry(now);
    const persistedParsed = await collections.jobsParsed.findOneAndUpdate(
      {
        jobContentHash: rawDoc.jobContentHash,
        parserVersion: versions.parserVersion,
      },
      {
        $set: {
          source: canonical.source,
          host: canonical.host,
          canonicalUrlHash: canonical.canonicalUrlHash,
          jobContentHash: rawDoc.jobContentHash,
          parserVersion: versions.parserVersion,
          parsed: parsedFeatures,
          tags: parsedFeatures.tags,
          confidence: parsedFeatures.confidence,
          updatedAt: now,
          expiresAt,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          createdAt: now,
        },
      },
      { upsert: true, returnDocument: "after" },
    );

    parsedDoc =
      persistedParsed && isCacheValid(persistedParsed.expiresAt, now)
        ? persistedParsed
        : null;
    parsedCacheHit = false;
  }

  if (!parsedDoc) {
    return reply
      .code(502)
      .send({ error: "Parsed vacancy cache is unavailable" });
  }

  const parsedFeatures = parsedDoc.parsed;
  const parsedFeaturesObject =
    parsedFeatures && typeof parsedFeatures === "object"
      ? (parsedFeatures as Record<string, unknown>)
      : {};

  const shouldCheckFullAnalysis = parse.data.scanDepth !== "lite";
  const profile = shouldCheckFullAnalysis
    ? await collections.birthProfiles.findOne(
        {
          userId: auth.user._id,
        },
        { projection: { profileHash: 1 } },
      )
    : null;

  const analysisFilter = profile
    ? {
        userId: auth.user._id,
        profileHash: profile.profileHash,
        jobContentHash: rawDoc.jobContentHash,
        rubricVersion: versions.rubricVersion,
        modelVersion: versions.modelVersion,
      }
    : null;

  const cachedAnalysis =
    parse.data.regenerate || !analysisFilter
      ? null
      : await collections.jobAnalyses.findOne(analysisFilter);
  if (cachedAnalysis) {
    const cachedLimits =
      selectedLimits ??
      await getCurrentJobUsageLimitSnapshot({
        userId: auth.user._id,
        plan,
        now,
      });
    const market = await buildJobMarketInsight({
      normalizedJob,
      log: request.log,
    });
    const response = buildCachedJobAnalyzeResponse({
      analysisId: cachedAnalysis._id.toHexString(),
      providerUsed: providerUsed ?? rawDoc.provider,
      rawCacheHit,
      parsedCacheHit,
      plan,
      limit: cachedLimits.full,
      limits: cachedLimits,
      market,
      versions,
      cachedResult: cachedAnalysis.result as Record<string, unknown>,
      parsedFeaturesObject,
      normalizedJob,
    });
    await upsertJobScanHistory({
      userId: auth.user._id,
      url: canonical.canonicalUrl,
      analysis: response,
      meta: {
        source: normalizedJob.source,
        cached: response.cached,
        provider: response.providerUsed,
      },
      savedAt: now,
      origin: 'url',
      canonicalUrlHash: canonical.canonicalUrlHash,
      jobContentHash: rawDoc.jobContentHash,
      profileHash: profile?.profileHash ?? null,
    });
    return response;
  }

  if (!selectedScanDepth || !selectedLimit || !selectedLimits) {
    const limits = await getCurrentJobUsageLimitSnapshot({
      userId: auth.user._id,
      plan,
      now,
    });
    const depthResolution = resolveJobScanDepth({
      limits,
      requestedDepth: parse.data.scanDepth,
    });
    if (!depthResolution.canProceed) {
      return reply.code(429).send({
        error: "Parse limit reached",
        code: "usage_limit_reached",
        scanDepth: depthResolution.depth,
        limit: depthResolution.limit,
        limits,
      });
    }
    selectedScanDepth = depthResolution.depth;
    selectedLimit = depthResolution.limit;
    selectedLimits = limits;
  }

  if (selectedScanDepth === "lite") {
    const market = await buildJobMarketInsight({
      normalizedJob,
      log: request.log,
    });
    await incrementUsageAfterSuccessfulScan({
      userId: auth.user._id,
      plan,
      depth: "lite",
      now,
    });
    usageIncremented = true;
    const postLimits = await getCurrentJobUsageLimitSnapshot({
      userId: auth.user._id,
      plan,
      now: new Date(),
    });

    const response = {
      analysisId: new ObjectId().toHexString(),
      status: "done",
      scanDepth: "lite",
      requestedScanDepth: parse.data.scanDepth,
      providerUsed: providerUsed ?? rawDoc.provider,
      providerAttempts,
      cached: false,
      cache: {
        raw: rawCacheHit,
        parsed: parsedCacheHit,
        analysis: false,
      },
      usage: {
        plan,
        depth: "lite",
        incremented: usageIncremented,
        limit: postLimits.lite,
        limits: postLimits,
      },
      versions,
      scores: {
        compatibility: 0,
        aiReplacementRisk: 0,
        overall: 0,
      },
      breakdown: [],
      jobSummary: market
        ? `${market.occupation.title} market snapshot based on public labor data.`
        : `${normalizedJob.title} role detected from vacancy payload.`,
      tags: asStringArray(parsedFeaturesObject.tags, 40),
      descriptors: asStringArray(parsedFeaturesObject.descriptors, 8),
      market,
      job: {
        title: normalizedJob.title,
        company: normalizedJob.company,
        location: normalizedJob.location,
        salaryText: normalizedJob.salaryText,
        employmentType: normalizedJob.employmentType,
        source: normalizedJob.source,
      },
    };
    await upsertJobScanHistory({
      userId: auth.user._id,
      url: canonical.canonicalUrl,
      analysis: response,
      meta: {
        source: normalizedJob.source,
        cached: response.cached,
        provider: response.providerUsed,
      },
      savedAt: now,
      origin: 'url',
      canonicalUrlHash: canonical.canonicalUrlHash,
      jobContentHash: rawDoc.jobContentHash,
      profileHash: null,
    });
    return response;
  }

  if (!profile) {
    return reply
      .code(404)
      .send({ error: "Birth profile not found. Complete onboarding first." });
  }

  const natalChart = await collections.natalCharts.findOne(
    {
      userId: auth.user._id,
      profileHash: profile.profileHash,
    },
    { projection: { chart: 1 } },
  );
  if (!natalChart) {
    return reply
      .code(404)
      .send({ error: "Natal chart not found. Generate chart first." });
  }

  const featuresForAnalysis = {
    parserVersion:
      typeof parsedFeaturesObject.parserVersion === "string"
        ? parsedFeaturesObject.parserVersion
        : versions.parserVersion,
    tags: asStringArray(parsedFeaturesObject.tags, 40),
    descriptors: asStringArray(parsedFeaturesObject.descriptors, 8),
    summary:
      typeof parsedFeaturesObject.summary === "string"
        ? parsedFeaturesObject.summary
        : `${normalizedJob.title} role detected from vacancy payload.`,
    confidence:
      typeof parsedFeaturesObject.confidence === "number"
        ? parsedFeaturesObject.confidence
        : Math.max(40, parsedDoc.confidence),
  };

  const analysisResult = buildDeterministicJobAnalysis({
    normalizedJob,
    features: featuresForAnalysis,
    natalChart: natalChart.chart,
  });

  if (!analysisFilter) {
    return reply.code(502).send({ error: "Full analysis cache key is unavailable" });
  }

  const persisted = await collections.jobAnalyses.findOneAndUpdate(
    analysisFilter,
    {
      $set: {
        source: canonical.source,
        canonicalUrlHash: canonical.canonicalUrlHash,
        provider: "deterministic",
        result: analysisResult,
        generatedAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: "after" },
  );

  if (!persisted) {
    return reply.code(502).send({ error: "Unable to persist job analysis" });
  }

  const market = await buildJobMarketInsight({
    normalizedJob,
    log: request.log,
  });
  await incrementUsageAfterSuccessfulScan({
    userId: auth.user._id,
    plan,
    depth: "full",
    now,
  });
  usageIncremented = true;
  const limits = await getCurrentJobUsageLimitSnapshot({
    userId: auth.user._id,
    plan,
    now: new Date(),
  });
  const response = {
    analysisId: persisted._id.toHexString(),
    status: "done",
    scanDepth: "full",
    requestedScanDepth: parse.data.scanDepth,
    providerUsed: providerUsed ?? rawDoc.provider,
    providerAttempts,
    cached: false,
    cache: {
      raw: rawCacheHit,
      parsed: parsedCacheHit,
      analysis: false,
    },
    usage: {
      plan,
      depth: "full",
      incremented: usageIncremented,
      limit: limits.full,
      limits,
    },
    versions,
    scores: analysisResult.scores,
    breakdown: analysisResult.breakdown,
    jobSummary: analysisResult.jobSummary,
    tags: analysisResult.tags,
    descriptors: analysisResult.descriptors,
    market,
    job: {
      title: normalizedJob.title,
      company: normalizedJob.company,
      location: normalizedJob.location,
      salaryText: normalizedJob.salaryText,
      employmentType: normalizedJob.employmentType,
      source: normalizedJob.source,
    },
  };
  await upsertJobScanHistory({
    userId: auth.user._id,
    url: canonical.canonicalUrl,
    analysis: response,
    meta: {
      source: normalizedJob.source,
      cached: response.cached,
      provider: response.providerUsed,
    },
    savedAt: now,
    origin: 'url',
    canonicalUrlHash: canonical.canonicalUrlHash,
    jobContentHash: rawDoc.jobContentHash,
    profileHash: profile.profileHash,
  });
  return response;
}
