import type { FastifyInstance } from 'fastify';
import { getCollections } from '../../db/mongo.js';
import { getDiscoverRoles } from '../discoverRoles.js';
import { requireAstrologyAuth } from './astrologyRouteGuards.js';
import { discoverRolesQuerySchema } from './astrologyShared.js';
import type { AstrologyRouteDependencies } from './astrologyRouteTypes.js';

export function registerAstrologyDiscoverRolesRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  app.get("/discover-roles", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedQuery = discoverRolesQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parsedQuery.error.flatten().fieldErrors,
      });
    }

    const collections = await getCollections();
    const profile = await collections.birthProfiles.findOne({
      userId: auth.user._id,
    });
    if (!profile) {
      return reply.code(404).send({
        error: "Birth profile not found. Complete onboarding first.",
      });
    }

    const natalChart = await collections.natalCharts.findOne({
      userId: auth.user._id,
      profileHash: profile.profileHash,
    });
    if (!natalChart) {
      return reply
        .code(404)
        .send({ error: "Natal chart not found. Generate chart first." });
    }

    try {
      return await getDiscoverRoles({
        userId: auth.user._id,
        profileHash: profile.profileHash,
        natalChart: natalChart.chart,
        query: parsedQuery.data.query,
        limit: parsedQuery.data.limit,
        searchLimit: parsedQuery.data.searchLimit,
        refresh: parsedQuery.data.refresh,
        deferSearchScores: parsedQuery.data.deferSearchScores,
        scoreSlug: parsedQuery.data.scoreSlug,
        log: request.log,
      });
    } catch (error) {
      request.log.error({ error }, "discover roles request failed");
      return reply
        .code(502)
        .send({ error: "Unable to build discover roles response" });
    }
  });
}
