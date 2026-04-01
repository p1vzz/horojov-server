import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { env } from '../../config/env.js';
import { getCollections } from '../../db/mongo.js';
import {
  generateCareerInsights,
  getInsightsConfig,
  type InsightTier,
} from '../careerInsights.js';
import { requireAstrologyAuth } from './astrologyRouteGuards.js';
import {
  buildChartPromptPayload,
  careerInsightsQuerySchema,
  MAX_CAREER_INSIGHTS,
  MIN_CAREER_INSIGHTS,
  westernChartSchema,
} from './astrologyShared.js';
import type { AstrologyRouteDependencies } from './astrologyRouteTypes.js';

export function registerAstrologyCareerInsightsRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  app.get("/career-insights", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parseQuery = careerInsightsQuerySchema.safeParse(request.query);
    if (!parseQuery.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parseQuery.error.flatten().fieldErrors,
      });
    }

    const tier = parseQuery.data.tier as InsightTier;
    const collections = await getCollections();
    const profile = await collections.birthProfiles.findOne({
      userId: auth.user._id,
    });
    if (!profile) {
      return reply.code(404).send({
        error: "Birth profile not found. Complete onboarding first.",
      });
    }

    const config = getInsightsConfig(tier);
    if (!parseQuery.data.regenerate) {
      const cached = await collections.careerInsights.findOne({
        userId: auth.user._id,
        profileHash: profile.profileHash,
        tier,
        promptVersion: config.promptVersion,
        model: config.model,
      });

      if (cached) {
        const normalizedInsights = cached.insights.slice(0, MAX_CAREER_INSIGHTS);
        if (normalizedInsights.length >= MIN_CAREER_INSIGHTS) {
          return {
            tier,
            cached: true,
            promptVersion: cached.promptVersion,
            model: cached.model,
            summary: cached.summary,
            insights: normalizedInsights,
            generatedAt: cached.generatedAt.toISOString(),
          };
        }

        request.log.warn(
          {
            userId: auth.user._id.toHexString(),
            tier,
            count: cached.insights.length,
          },
          "cached career insights count is out of expected range, regenerating",
        );
      }
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

    const parsedChart = westernChartSchema.safeParse(natalChart.chart);
    if (!parsedChart.success) {
      request.log.error(
        { issues: parsedChart.error.issues },
        "cached natal chart validation failed",
      );
      return reply
        .code(502)
        .send({ error: "Cached natal chart has invalid format" });
    }

    if (!env.OPENAI_API_KEY) {
      return reply.code(500).send({ error: "OpenAI API key is not configured" });
    }

    try {
      const generated = await generateCareerInsights({
        tier,
        chartPayload: buildChartPromptPayload(parsedChart.data),
      });

      const now = new Date();
      await collections.careerInsights.updateOne(
        {
          userId: auth.user._id,
          profileHash: profile.profileHash,
          tier,
          promptVersion: generated.promptVersion,
          model: generated.model,
        },
        {
          $set: {
            summary: generated.insights.summary,
            insights: generated.insights.insights,
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

      return {
        tier,
        cached: false,
        promptVersion: generated.promptVersion,
        model: generated.model,
        summary: generated.insights.summary,
        insights: generated.insights.insights.slice(0, MAX_CAREER_INSIGHTS),
        generatedAt: now.toISOString(),
      };
    } catch (error) {
      request.log.error({ error }, "career insights generation failed");
      return reply.code(502).send({ error: "Unable to generate career insights" });
    }
  });
}
