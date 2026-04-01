import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { buildTodayDate } from "../dailyTransit.js";
import { getOrCreateMorningBriefingForUser } from "../morningBriefing.js";
import { requirePremiumAstrologyAuth } from "./astrologyRouteGuards.js";
import {
  fullNatalAnalysisQuerySchema,
  getOrCreateFullNatalAnalysisForUser,
  morningBriefingQuerySchema,
} from "./astrologyShared.js";
import type { AstrologyRouteDependencies } from "./astrologyRouteTypes.js";

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
  mode: "build" | "regenerate",
) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("Birth profile not found")) {
    return reply.code(404).send({
      error: "Birth profile not found. Complete onboarding first.",
    });
  }
  if (message.includes("Natal chart not found")) {
    return reply
      .code(404)
      .send({ error: "Natal chart not found. Generate chart first." });
  }
  if (message.includes("OpenAI API key is not configured")) {
    return reply.code(500).send({ error: "OpenAI API key is not configured" });
  }
  request.log.error(
    { error },
    mode === "build"
      ? "full natal analysis request failed"
      : "full natal analysis regenerate failed",
  );
  return reply.code(502).send({
    error:
      mode === "build"
        ? "Unable to build full natal analysis"
        : "Unable to regenerate full natal analysis",
  });
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
      return await getOrCreateFullNatalAnalysisForUser({
        userId: auth.user._id,
        refresh: parsedQuery.data.refresh,
        logger: request.log,
      });
    } catch (error) {
      return handleFullNatalAnalysisError(error, request, reply, "build");
    }
  });

  app.post("/full-natal-analysis/regenerate", async (request, reply) => {
    const auth = await requirePremiumAstrologyAuth(request, reply, deps);
    if (!auth) return;

    try {
      return await getOrCreateFullNatalAnalysisForUser({
        userId: auth.user._id,
        refresh: true,
        logger: request.log,
      });
    } catch (error) {
      return handleFullNatalAnalysisError(error, request, reply, "regenerate");
    }
  });
}
