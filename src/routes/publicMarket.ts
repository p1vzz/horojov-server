import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getOccupationInsight,
  type OccupationInsightDependencies,
} from '../services/marketData/occupationInsight.js';
import {
  MarketProviderError,
  statusForMarketProviderError,
} from '../services/marketData/providerErrors.js';

const occupationInsightQuerySchema = z.object({
  keyword: z.string().trim().min(2).max(120),
  location: z.string().trim().min(2).max(80).default('US'),
});

export type PublicMarketRouteDependencies = {
  getOccupationInsight: typeof getOccupationInsight;
};

export type RegisterPublicMarketRoutesOptions = {
  deps?: Partial<PublicMarketRouteDependencies>;
  occupationInsightDeps?: OccupationInsightDependencies;
};

const defaultDeps: PublicMarketRouteDependencies = {
  getOccupationInsight,
};

export async function registerPublicMarketRoutes(
  app: FastifyInstance,
  options: RegisterPublicMarketRoutesOptions = {},
): Promise<void> {
  const deps = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };

  app.get('/occupation-insight', async (request, reply) => {
    const queryParse = occupationInsightQuerySchema.safeParse(request.query ?? {});
    if (!queryParse.success) {
      return reply.code(400).send({
        error: 'Invalid market insight query',
        details: queryParse.error.flatten().fieldErrors,
      });
    }

    try {
      const response = await deps.getOccupationInsight(
        {
          ...queryParse.data,
          refresh: false,
        },
        options.occupationInsightDeps,
      );

      reply.header(
        'Cache-Control',
        'public, max-age=300, s-maxage=300, stale-while-revalidate=86400',
      );
      return reply.send(response);
    } catch (error) {
      if (error instanceof MarketProviderError) {
        request.log.warn(
          {
            code: error.code,
            upstreamStatus: error.status,
          },
          'Public market provider request failed',
        );
        return reply.code(statusForMarketProviderError(error)).send({
          error: marketErrorMessage(error),
          code: error.code,
        });
      }

      request.log.error({ error }, 'Public market insight request failed');
      return reply.code(502).send({
        error: 'Unable to complete market insight request',
        code: 'market_provider_unavailable',
      });
    }
  });
}

function marketErrorMessage(error: MarketProviderError) {
  switch (error.code) {
    case 'market_no_match':
      return 'No matching occupation found';
    case 'market_provider_unconfigured':
      return 'Market data provider is not configured';
    case 'market_provider_rate_limited':
      return 'Market data provider rate limit exceeded';
    case 'market_provider_timeout':
      return 'Market data provider request timed out';
    case 'market_provider_unauthorized':
    case 'market_provider_unavailable':
    case 'market_provider_invalid_payload':
      return 'Market data is temporarily unavailable';
  }
}
