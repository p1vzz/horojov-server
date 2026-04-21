import type { FastifyReply, FastifyRequest } from 'fastify';
import { ObjectId } from 'mongodb';
import { getCollections } from '../../db/mongo.js';
import { authenticateByAuthorizationHeader } from '../auth.js';
import {
  buildDeterministicJobAnalysis,
  extractJobFeatures,
  getJobAnalysisVersions,
} from '../jobAnalysis.js';
import type { NormalizedJobPayload } from '../jobProviders.js';
import {
  JobScreenshotParseError,
  parseJobFromScreenshots,
} from '../jobScreenshotParser.js';
import {
  getCurrentUsageLimitState,
  incrementUsageAfterSuccessfulProviderCall,
  resolveUserUsagePlan,
} from '../jobUsageLimits.js';
import { isSupportedSource } from './common.js';
import { analyzeScreenshotsSchema } from './schemas.js';

export async function handleJobAnalyzeScreenshots(
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const auth = await authenticateByAuthorizationHeader(
    request.headers.authorization,
  );
  if (!auth) {
    return reply.code(401).send({ error: "Unauthorized" });
  }

  const parse = analyzeScreenshotsSchema.safeParse(request.body);
  if (!parse.success) {
    return reply.code(400).send({
      error: "Invalid request payload",
      details: parse.error.flatten().fieldErrors,
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

  const plan = resolveUserUsagePlan(auth.user);
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

  let parsedScreenshot: Awaited<ReturnType<typeof parseJobFromScreenshots>>;
  try {
    parsedScreenshot = await parseJobFromScreenshots({
      screenshots: parse.data.screenshots.map((entry) => entry.dataUrl),
    });
  } catch (error) {
    if (error instanceof JobScreenshotParseError) {
      if (error.code === "screenshot_not_vacancy") {
        return reply.code(422).send({
          error: "Uploaded screenshots do not look like a vacancy page.",
          code: "screenshot_not_vacancy",
          reason: error.details.reason ?? null,
          confidence: error.details.confidence ?? null,
        });
      }

      if (error.code === "screenshot_incomplete_info") {
        return reply.code(422).send({
          error: "Not enough vacancy details are visible in screenshots.",
          code: "screenshot_incomplete_info",
          reason: error.details.reason ?? null,
          confidence: error.details.confidence ?? null,
          missingFields: Array.isArray(error.details.missingFields)
            ? error.details.missingFields
            : [],
        });
      }

      return reply.code(400).send({
        error: error.message,
        code: error.code,
        details: error.details,
      });
    }

    request.log.error({ error }, "screenshot parse failed");
    return reply.code(502).send({
      error: "Screenshot parsing failed",
      code: "screenshot_parse_failed",
    });
  }

  const sourceForScoring = isSupportedSource(parsedScreenshot.sourceHint)
    ? parsedScreenshot.sourceHint
    : "linkedin";
  const normalizedFromScreenshots: NormalizedJobPayload = {
    source: sourceForScoring,
    sourceJobId: null,
    canonicalUrl: "screenshot://manual",
    title: parsedScreenshot.job.title,
    company: parsedScreenshot.job.company,
    location: parsedScreenshot.job.location,
    description: parsedScreenshot.job.description,
    employmentType: parsedScreenshot.job.employmentType,
    datePosted: null,
    seniority: parsedScreenshot.job.seniority,
  };

  const parsedFeatures = extractJobFeatures(normalizedFromScreenshots);
  const analysisResult = buildDeterministicJobAnalysis({
    normalizedJob: normalizedFromScreenshots,
    features: parsedFeatures,
    natalChart: natalChart.chart,
  });

  await incrementUsageAfterSuccessfulProviderCall({
    userId: auth.user._id,
    plan,
    now,
  });
  const postLimit = await getCurrentUsageLimitState({
    userId: auth.user._id,
    plan,
    now: new Date(),
  });

  return {
    analysisId: new ObjectId().toHexString(),
    status: "done",
    providerUsed: "screenshot_vision",
    cached: false,
    cache: {
      raw: false,
      parsed: false,
      analysis: false,
    },
    usage: {
      plan,
      incremented: true,
      limit: postLimit,
    },
    versions: {
      ...versions,
      screenshotPromptVersion: parsedScreenshot.promptVersion,
      screenshotModel: parsedScreenshot.model,
    },
    scores: analysisResult.scores,
    breakdown: analysisResult.breakdown,
    jobSummary: analysisResult.jobSummary,
    tags: analysisResult.tags,
    descriptors: analysisResult.descriptors,
    job: {
      title: parsedScreenshot.job.title,
      company: parsedScreenshot.job.company,
      location: parsedScreenshot.job.location,
      employmentType: parsedScreenshot.job.employmentType,
      source: parsedScreenshot.sourceHint ?? "manual",
    },
    screenshot: {
      imageCount: parsedScreenshot.imageCount,
      confidence: parsedScreenshot.confidence,
      reason: parsedScreenshot.reason,
    },
  };
}
