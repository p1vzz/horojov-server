import type { FastifyReply, FastifyRequest } from "fastify";
import { getCollections } from "../../db/mongo.js";
import { authenticateByAuthorizationHeader } from "../auth.js";
import { getJobAnalysisVersions } from "../jobAnalysis.js";
import { isCacheValid } from "../jobCachePolicy.js";
import { validateAndCanonicalizeJobUrl } from "../jobUrl.js";
import {
  getCurrentUsageLimitState,
  resolveUserUsagePlan,
} from "../jobUsageLimits.js";
import {
  getValidationErrorMessage,
  statusCodeForValidationCode,
} from "./common.js";
import { preflightSchema } from "./schemas.js";

export async function handleJobPreflight(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = await authenticateByAuthorizationHeader(
    request.headers.authorization,
  );
  if (!auth) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const parse = preflightSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.code(400).send({
      error: "Invalid request payload",
      details: parse.error.flatten().fieldErrors,
    });
  }

  const preflight = validateAndCanonicalizeJobUrl(parse.data.url);
  if (!preflight.ok) {
    return reply.code(statusCodeForValidationCode(preflight.code)).send({
      error: getValidationErrorMessage(preflight.code, preflight.message),
      code: preflight.code,
    });
  }

  const versions = getJobAnalysisVersions();
  const { data } = preflight;
  const now = new Date();
  const collections = await getCollections();
  const rawCacheCandidate = await collections.jobsRaw.findOne({
    canonicalUrlHash: data.canonicalUrlHash,
  }, {
    projection: {
      jobContentHash: 1,
      updatedAt: 1,
      expiresAt: 1,
    },
  });
  const rawCache =
    rawCacheCandidate && isCacheValid(rawCacheCandidate.expiresAt, now)
      ? rawCacheCandidate
      : null;
  const negativeCacheCandidate =
    rawCache === null
      ? await collections.jobFetchNegativeCache.findOne({
          canonicalUrlHash: data.canonicalUrlHash,
        }, {
          projection: {
            status: 1,
            expiresAt: 1,
          },
        })
      : null;
  const negativeCache =
    negativeCacheCandidate &&
    isCacheValid(negativeCacheCandidate.expiresAt, now)
      ? negativeCacheCandidate
      : null;

  const parsedCacheCandidate =
    rawCache === null
      ? null
      : await collections.jobsParsed.findOne({
          jobContentHash: rawCache.jobContentHash,
          parserVersion: versions.parserVersion,
        }, {
          projection: {
            parserVersion: 1,
            updatedAt: 1,
            expiresAt: 1,
          },
        });

  const parsedCache =
    parsedCacheCandidate && isCacheValid(parsedCacheCandidate.expiresAt, now)
      ? parsedCacheCandidate
      : null;

  const userProfile = await collections.birthProfiles.findOne(
    { userId: auth.user._id },
    { projection: { profileHash: 1 } },
  );

  const analysisCache =
    rawCache === null || userProfile === null
      ? null
      : await collections.jobAnalyses.findOne({
          userId: auth.user._id,
          profileHash: userProfile.profileHash,
          jobContentHash: rawCache.jobContentHash,
          rubricVersion: versions.rubricVersion,
          modelVersion: versions.modelVersion,
        }, {
          projection: {
            rubricVersion: 1,
            modelVersion: 1,
            updatedAt: 1,
          },
        });

  const plan = resolveUserUsagePlan(auth.user);
  const limit = await getCurrentUsageLimitState({
    userId: auth.user._id,
    plan,
    now,
  });
  const nextStage = analysisCache
    ? "done"
    : parsedCache
      ? "running_scoring"
      : rawCache
        ? "normalizing_job_payload"
        : negativeCache
          ? "cooldown"
          : "fetching_http_fetch";

  return {
    source: data.source,
    canonicalUrl: data.canonicalUrl,
    canonicalUrlHash: data.canonicalUrlHash,
    sourceJobId: data.sourceJobId,
    routing: data.routing,
    nextStage,
    cache: {
      raw: {
        hit: rawCache !== null,
        updatedAt: rawCache?.updatedAt.toISOString() ?? null,
      },
      parsed: {
        hit: parsedCache !== null,
        parserVersion: parsedCache?.parserVersion ?? null,
        updatedAt: parsedCache?.updatedAt.toISOString() ?? null,
      },
      analysis: {
        hit: analysisCache !== null,
        rubricVersion: analysisCache?.rubricVersion ?? null,
        modelVersion: analysisCache?.modelVersion ?? null,
        updatedAt: analysisCache?.updatedAt.toISOString() ?? null,
      },
      negative: {
        hit: negativeCache !== null,
        status: negativeCache?.status ?? null,
        retryAt: negativeCache?.expiresAt.toISOString() ?? null,
      },
    },
    limit,
    versions,
  };
}
