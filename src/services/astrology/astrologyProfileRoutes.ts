import type { FastifyInstance } from "fastify";
import { getCollections } from "../../db/mongo.js";
import { listAiSynergyHistory } from "../aiSynergy.js";
import {
  buildTodayDate,
  getOrCreateDailyTransitForUser,
  toDailyTransitResponse,
} from "../dailyTransit.js";
import {
  aiSynergyHistoryQuerySchema,
  natalChartRequestSchema,
  upsertBirthProfile,
} from "./astrologyShared.js";
import { requireAstrologyAuth } from "./astrologyRouteGuards.js";
import type { AstrologyRouteDependencies } from "./astrologyRouteTypes.js";

export function registerAstrologyProfileRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  app.get("/birth-profile", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const collections = await getCollections();
    const profile = await collections.birthProfiles.findOne({
      userId: auth.user._id,
    });
    if (!profile) {
      return reply.code(404).send({ error: "Birth profile is not set" });
    }

    return {
      profile: {
        name: typeof profile.name === "string" ? profile.name : "",
        birthDate: profile.birthDate,
        birthTime: profile.birthTime,
        unknownTime: profile.unknownTime,
        city: profile.city,
        latitude:
          typeof profile.latitude === "number" ? profile.latitude : null,
        longitude:
          typeof profile.longitude === "number" ? profile.longitude : null,
        country: profile.country ?? null,
        admin1: profile.admin1 ?? null,
        updatedAt: profile.updatedAt.toISOString(),
      },
    };
  });

  app.put("/birth-profile", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsed = natalChartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request payload",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    await upsertBirthProfile(auth.user._id, parsed.data);
    return {
      profile: {
        ...parsed.data,
      },
    };
  });

  app.get("/daily-transit", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    try {
      const result = await getOrCreateDailyTransitForUser(
        auth.user._id,
        buildTodayDate(),
        request.log,
      );
      return toDailyTransitResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Birth profile not found")) {
        return reply.code(404).send({
          error: "Birth profile not found. Complete onboarding first.",
        });
      }
      request.log.error({ error }, "daily transit request failed");
      return reply.code(502).send({ error: "Unable to build daily transit" });
    }
  });

  app.get("/ai-synergy/history", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsed = aiSynergyHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const history = await listAiSynergyHistory({
      userId: auth.user._id,
      days: parsed.data.days,
      limit: parsed.data.limit,
    });

    return {
      days: parsed.data.days,
      count: history.length,
      items: history,
    };
  });
}
