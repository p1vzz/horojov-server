import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { MarketProviderError } from '../services/marketData/providerErrors.js';
import type { OccupationInsightResponse } from '../services/marketData/types.js';
import {
  registerPublicMarketRoutes,
  type PublicMarketRouteDependencies,
} from './publicMarket.js';

const sampleInsight: OccupationInsightResponse = {
  query: {
    keyword: 'software developer',
    location: 'US',
  },
  occupation: {
    onetCode: '15-1252.00',
    socCode: '151252',
    title: 'Software Developers',
    description: 'Develop software.',
    matchConfidence: 'high',
  },
  salary: {
    currency: 'USD',
    period: 'annual',
    min: 103000,
    max: 161480,
    median: 133080,
    year: '2024',
    confidence: 'high',
    basis: 'market_estimate',
  },
  outlook: {
    growthLabel: 'Rapid Growth',
    projectedOpenings: 140100,
    projectionYears: '2023-2033',
    demandLabel: 'high',
  },
  skills: [
    {
      name: 'Programming',
      category: 'skill',
      sourceProvider: 'careeronestop',
    },
  ],
  labels: {
    marketScore: 'strong market',
    salaryVisibility: 'market_estimate',
  },
  sources: [
    {
      provider: 'careeronestop',
      label: 'CareerOneStop',
      url: 'https://www.careeronestop.org/',
      retrievedAt: '2026-04-22T00:00:00.000Z',
      attributionText: 'CareerOneStop citation.',
      logoRequired: true,
    },
  ],
};

async function buildPublicMarketTestApp(
  deps?: Partial<PublicMarketRouteDependencies>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerPublicMarketRoutes, {
    prefix: '/api/public/market',
    deps,
  });
  return app;
}

test('public market route rejects invalid query before provider work', async () => {
  let insightCalls = 0;
  const app = await buildPublicMarketTestApp({
    getOccupationInsight: async () => {
      insightCalls += 1;
      return sampleInsight;
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/public/market/occupation-insight?keyword=x',
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'Invalid market insight query');
    assert.equal(insightCalls, 0);
  } finally {
    await app.close();
  }
});

test('public market route returns normalized occupation insight without auth', async () => {
  let capturedQuery: unknown = null;
  const app = await buildPublicMarketTestApp({
    getOccupationInsight: async (query) => {
      capturedQuery = query;
      return sampleInsight;
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/public/market/occupation-insight?keyword=software%20developer&refresh=true',
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(capturedQuery, {
      keyword: 'software developer',
      location: 'US',
      refresh: false,
    });
    assert.equal(
      response.headers['cache-control'],
      'public, max-age=300, s-maxage=300, stale-while-revalidate=86400',
    );
    assert.deepEqual(response.json(), sampleInsight);
  } finally {
    await app.close();
  }
});

test('public market route maps provider errors to stable error codes', async () => {
  const app = await buildPublicMarketTestApp({
    getOccupationInsight: async () => {
      throw new MarketProviderError('market_no_match', 'no match', 404);
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/public/market/occupation-insight?keyword=unknown%20role',
    });

    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: 'No matching occupation found',
      code: 'market_no_match',
    });
  } finally {
    await app.close();
  }
});
