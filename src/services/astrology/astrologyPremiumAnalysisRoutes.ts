import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { buildTodayDate } from '../dailyTransit.js';
import { getOrCreateMorningBriefingForUser } from '../morningBriefing.js';
import { requirePremiumAstrologyAuth } from './astrologyRouteGuards.js';
import {
  fullNatalAnalysisQuerySchema,
  getOrCreateFullNatalAnalysisForUser,
  getFullNatalAnalysisProgressForUser,
  morningBriefingQuerySchema,
} from './astrologyShared.js';
import type { AstrologyRouteDependencies } from './astrologyRouteTypes.js';
import {
  FullNatalAnalysisGenerationError,
  type FullNatalAnalysisGenerationFailureCode,
} from '../fullNatalAnalysis.js';

function handleMorningBriefingError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Birth profile not found")) {
    return reply.code(404).send({
      error: "Birth profile not found. Complete onboarding first.",
    });
  }
  if (message.includes("Astrology API credentials are not configured")) {
    return reply
      .code(500)
      .send({ error: "Astrology API credentials are not configured" });
  }
  request.log.error({ error }, "morning briefing request failed");
  return reply.code(502).send({ error: "Unable to build morning briefing" });
}

function handleFullNatalAnalysisError(
  error: unknown,
  request: FastifyRequest,
  reply: FastifyReply,
) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Birth profile not found")) {
    return reply.code(404).send({
      error: "Birth profile not found. Complete onboarding first.",
      code: "birth_profile_missing",
    });
  }
  if (message.includes("Natal chart not found")) {
    return reply
      .code(404)
      .send({
        error: "Natal chart not found. Generate chart first.",
        code: "natal_chart_missing",
      });
  }
  if (error instanceof FullNatalAnalysisGenerationError) {
    request.log.error(
      { error, code: error.code },
      "full natal analysis generation failed",
    );
    return reply.code(statusForFullNatalGenerationCode(error.code)).send({
      error: "Full natal analysis generation failed.",
      code: error.code,
    });
  }
  request.log.error(
    { error },
    "full natal analysis request failed",
  );
  return reply.code(502).send({
    error: "Unable to build full natal analysis",
    code: "full_natal_analysis_failed",
  });
}

export function statusForFullNatalGenerationCode(code: FullNatalAnalysisGenerationFailureCode) {
  switch (code) {
    case "full_natal_llm_timeout":
      return 504;
    case "full_natal_llm_rate_limited":
      return 503;
    case "full_natal_llm_unavailable":
    case "full_natal_llm_unconfigured":
      return 503;
    case "full_natal_llm_invalid_response":
    case "full_natal_llm_upstream_error":
      return 502;
    default:
      return 502;
  }
}

export function registerAstrologyPremiumAnalysisRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  app.get("/morning-briefing", async (request, reply) => {
    const auth = await requirePremiumAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedQuery = morningBriefingQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parsedQuery.error.flatten().fieldErrors,
      });
    }

    try {
      const result = await getOrCreateMorningBriefingForUser({
        userId: auth.user._id,
        date: buildTodayDate(),
        logger: request.log,
        refresh: parsedQuery.data.refresh,
      });
      return result.item;
    } catch (error) {
      return handleMorningBriefingError(error, request, reply);
    }
  });

  app.get("/full-natal-analysis", async (request, reply) => {
    const auth = await requirePremiumAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedQuery = fullNatalAnalysisQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parsedQuery.error.flatten().fieldErrors,
      });
    }

    try {
      const result = await getOrCreateFullNatalAnalysisForUser({
        userId: auth.user._id,
        cacheOnly: parsedQuery.data.cacheOnly,
        logger: request.log,
      });
      if (!result) {
        return reply.code(404).send({
          error: "Full natal analysis has not been generated yet.",
          code: "full_natal_analysis_not_ready",
        });
      }
      return result;
    } catch (error) {
      return handleFullNatalAnalysisError(error, request, reply);
    }
  });

  app.get("/full-natal-analysis/progress", async (request, reply) => {
    const auth = await requirePremiumAstrologyAuth(request, reply, deps);
    if (!auth) return;

    try {
      return await getFullNatalAnalysisProgressForUser({
        userId: auth.user._id,
      });
    } catch (error) {
      request.log.error({ error }, "full natal analysis progress request failed");
      return reply.code(502).send({
        error: "Unable to load full natal analysis progress",
        code: "full_natal_progress_failed",
      });
    }
  });
}
