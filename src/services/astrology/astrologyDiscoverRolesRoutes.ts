import type { FastifyInstance } from 'fastify';
import { getCollections } from '../../db/mongo.js';
import type { OccupationInsightResponse } from '../marketData/types.js';
import {
  clearDiscoverRoleCurrentJob,
  getDiscoverRoleCurrentJob,
  upsertDiscoverRoleCurrentJob,
} from './discoverRoleCurrentJobStore.js';
import {
  listDiscoverRoleShortlistEntries,
  removeDiscoverRoleShortlistEntry,
  upsertDiscoverRoleShortlistEntry,
} from './discoverRoleShortlistStore.js';
import {
  getDiscoverRoles,
  type DiscoverRoleDetail,
} from '../discoverRoles.js';
import { requireAstrologyAuth } from './astrologyRouteGuards.js';
import {
  discoverRoleCurrentJobBodySchema,
  discoverRolesQuerySchema,
  discoverRoleShortlistBodySchema,
  discoverRoleShortlistParamsSchema,
} from './astrologyShared.js';
import type { AstrologyRouteDependencies } from './astrologyRouteTypes.js';

export function registerAstrologyDiscoverRolesRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  app.get("/discover-roles/current-job", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    try {
      return {
        currentJob: await getDiscoverRoleCurrentJob({
          userId: auth.user._id,
        }),
      };
    } catch (error) {
      request.log.error({ error }, "discover role current job fetch failed");
      return reply
        .code(502)
        .send({ error: "Unable to load discover role current job" });
    }
  });

  app.put("/discover-roles/current-job", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedBody = discoverRoleCurrentJobBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: "Invalid current job payload",
        details: parsedBody.error.flatten().fieldErrors,
      });
    }

    try {
      return {
        currentJob: await upsertDiscoverRoleCurrentJob({
          userId: auth.user._id,
          title: parsedBody.data.title,
        }),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes("Birth profile is required")) {
        return reply
          .code(404)
          .send({ error: "Birth profile not found. Complete onboarding first." });
      }
      request.log.error({ error }, "discover role current job upsert failed");
      return reply
        .code(502)
        .send({ error: "Unable to save discover role current job" });
    }
  });

  app.delete("/discover-roles/current-job", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    try {
      return await clearDiscoverRoleCurrentJob({
        userId: auth.user._id,
      });
    } catch (error) {
      request.log.error({ error }, "discover role current job delete failed");
      return reply
        .code(502)
        .send({ error: "Unable to clear discover role current job" });
    }
  });

  app.get("/discover-roles/shortlist", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    try {
      return await listDiscoverRoleShortlistEntries({
        userId: auth.user._id,
      });
    } catch (error) {
      request.log.error({ error }, "discover role shortlist fetch failed");
      return reply
        .code(502)
        .send({ error: "Unable to load discover role shortlist" });
    }
  });

  app.put("/discover-roles/shortlist/:slug", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedParams = discoverRoleShortlistParamsSchema.safeParse(
      request.params,
    );
    if (!parsedParams.success) {
      return reply.code(400).send({
        error: "Invalid shortlist params",
        details: parsedParams.error.flatten().fieldErrors,
      });
    }

    const parsedBody = discoverRoleShortlistBodySchema.safeParse(request.body);
    if (!parsedBody.success) {
      return reply.code(400).send({
        error: "Invalid shortlist payload",
        details: parsedBody.error.flatten().fieldErrors,
      });
    }

    try {
      return await upsertDiscoverRoleShortlistEntry({
        userId: auth.user._id,
        slug: parsedParams.data.slug,
        role: parsedBody.data.role,
        domain: parsedBody.data.domain,
        scoreLabel: parsedBody.data.scoreLabel,
        scoreValue: parsedBody.data.scoreValue,
        tags: parsedBody.data.tags,
        market: parsedBody.data.market as OccupationInsightResponse | null,
        detail: parsedBody.data.detail as DiscoverRoleDetail | null,
        savedAt: parsedBody.data.savedAt,
      });
    } catch (error) {
      request.log.error({ error }, "discover role shortlist upsert failed");
      return reply
        .code(502)
        .send({ error: "Unable to save discover role shortlist entry" });
    }
  });

  app.delete("/discover-roles/shortlist/:slug", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedParams = discoverRoleShortlistParamsSchema.safeParse(
      request.params,
    );
    if (!parsedParams.success) {
      return reply.code(400).send({
        error: "Invalid shortlist params",
        details: parsedParams.error.flatten().fieldErrors,
      });
    }

    try {
      return await removeDiscoverRoleShortlistEntry({
        userId: auth.user._id,
        slug: parsedParams.data.slug,
      });
    } catch (error) {
      request.log.error({ error }, "discover role shortlist delete failed");
      return reply
        .code(502)
        .send({ error: "Unable to remove discover role shortlist entry" });
    }
  });

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
      const currentJob = await getDiscoverRoleCurrentJob({
        userId: auth.user._id,
      });
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
        rankingMode: parsedQuery.data.rankingMode,
        currentJob,
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
