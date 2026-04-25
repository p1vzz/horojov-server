import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  authenticateByAuthorizationHeader,
  type AuthContext,
} from '../services/auth.js';
import {
  getOccupationInsight,
  type OccupationInsightDependencies,
} from '../services/marketData/occupationInsight.js';
import {
  MarketProviderError,
  statusForMarketProviderError,
} from '../services/marketData/providerErrors.js';

const refreshQuerySchema = z.preprocess((value) => {
  if (value === undefined) return false;
  if (typeof value !== 'string') return value;
  const normalized = value.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', ''].includes(normalized)) return false;
  return value;
}, z.boolean().default(false));

const occupationInsightQuerySchema = z.object({
  keyword: z.string().trim().min(2).max(120),
  location: z.string().trim().min(2).max(80).default('US'),
  refresh: refreshQuerySchema,
});

export type MarketRouteDependencies = {
  authenticateByAuthorizationHeader: (
    authorization?: string,
  ) => Promise<AuthContext | null>;
  getOccupationInsight: typeof getOccupationInsight;
};

export type RegisterMarketRoutesOptions = {
  deps?: Partial<MarketRouteDependencies>;
  occupationInsightDeps?: OccupationInsightDependencies;
};

const defaultDeps: MarketRouteDependencies = {
  authenticateByAuthorizationHeader,
  getOccupationInsight,
};

export async function registerMarketRoutes(
  app: FastifyInstance,
  options: RegisterMarketRoutesOptions = {},
): Promise<void> {
  const deps = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };

  app.get('/occupation-insight', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(
      request.headers.authorization,
    );
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const queryParse = occupationInsightQuerySchema.safeParse(request.query ?? {});
    if (!queryParse.success) {
      return reply.code(400).send({
        error: 'Invalid market insight query',
        details: queryParse.error.flatten().fieldErrors,
      });
    }

    try {
      return await deps.getOccupationInsight(queryParse.data, options.occupationInsightDeps);
    } catch (error) {
      if (error instanceof MarketProviderError) {
        request.log.warn(
          {
            code: error.code,
            upstreamStatus: error.status,
          },
          'Market provider request failed',
        );
        return reply.code(statusForMarketProviderError(error)).send({
          error: marketErrorMessage(error),
          code: error.code,
        });
      }

      request.log.error({ error }, 'Market insight request failed');
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
