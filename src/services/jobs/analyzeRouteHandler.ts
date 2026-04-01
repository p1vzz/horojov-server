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
} from '../jobProviders.js';
import { validateAndCanonicalizeJobUrl } from '../jobUrl.js';
import {
  getCurrentUsageLimitState,
  incrementUsageAfterSuccessfulProviderCall,
  resolveUserUsagePlan,
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
import { analyzeSchema } from './schemas.js';

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
  const profile = await collections.birthProfiles.findOne(
    {
      userId: auth.user._id,
    },
    { projection: { profileHash: 1 } },
  );
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
    const limit = await getCurrentUsageLimitState({
      userId: auth.user._id,
      plan,
      now,
    });
    if (!limit.canProceed) {
      return reply.code(429).send({
        error: "Parse limit reached",
        code: "usage_limit_reached",
        limit,
      });
    }

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
      incrementUsageAfterSuccessfulProviderCall({
        userId: auth.user._id,
        plan,
        now,
      }),
    ]);
    usageIncremented = true;
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

  const analysisFilter = {
    userId: auth.user._id,
    profileHash: profile.profileHash,
    jobContentHash: rawDoc.jobContentHash,
    rubricVersion: versions.rubricVersion,
    modelVersion: versions.modelVersion,
  };

  const cachedAnalysis = parse.data.regenerate
    ? null
    : await collections.jobAnalyses.findOne(analysisFilter);
  if (cachedAnalysis) {
    return {
      analysisId: cachedAnalysis._id.toHexString(),
      status: "done",
      providerUsed: providerUsed ?? rawDoc.provider,
      cached: true,
      cache: {
        raw: rawCacheHit,
        parsed: parsedCacheHit,
        analysis: true,
      },
      usage: {
        plan,
        incremented: false,
      },
      versions,
      scores: (cachedAnalysis.result as Record<string, unknown>).scores ?? null,
      breakdown:
        (cachedAnalysis.result as Record<string, unknown>).breakdown ?? [],
      jobSummary:
        (cachedAnalysis.result as Record<string, unknown>).jobSummary ?? "",
      tags: (cachedAnalysis.result as Record<string, unknown>).tags ?? [],
    };
  }

  const parsedFeatures = parsedDoc.parsed;
  const parsedFeaturesObject =
    parsedFeatures && typeof parsedFeatures === "object"
      ? (parsedFeatures as Record<string, unknown>)
      : {};

  const featuresForAnalysis = {
    parserVersion:
      typeof parsedFeaturesObject.parserVersion === "string"
        ? parsedFeaturesObject.parserVersion
        : versions.parserVersion,
    tags: Array.isArray(parsedFeaturesObject.tags)
      ? parsedFeaturesObject.tags
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 40)
      : [],
    descriptors: Array.isArray(parsedFeaturesObject.descriptors)
      ? parsedFeaturesObject.descriptors
          .filter((entry): entry is string => typeof entry === "string")
          .slice(0, 8)
      : [],
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

  const limit = await getCurrentUsageLimitState({
    userId: auth.user._id,
    plan,
    now: new Date(),
  });
  return {
    analysisId: persisted._id.toHexString(),
    status: "done",
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
      incremented: usageIncremented,
      limit,
    },
    versions,
    scores: analysisResult.scores,
    breakdown: analysisResult.breakdown,
    jobSummary: analysisResult.jobSummary,
    tags: analysisResult.tags,
    descriptors: analysisResult.descriptors,
    job: {
      title: normalizedJob.title,
      company: normalizedJob.company,
      location: normalizedJob.location,
      employmentType: normalizedJob.employmentType,
      source: normalizedJob.source,
    },
  };
}
