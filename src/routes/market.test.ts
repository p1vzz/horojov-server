import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../services/auth.js';
import { MarketProviderError } from '../services/marketData/providerErrors.js';
import type { OccupationInsightResponse } from '../services/marketData/types.js';
import { registerMarketRoutes, type MarketRouteDependencies } from './market.js';

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

function buildFakeAuthContext(): AuthContext {
  const userId = new ObjectId();
  const now = new Date();
  return {
    user: {
      _id: userId,
      kind: 'anonymous',
      subscriptionTier: 'free',
      email: null,
      displayName: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    },
    session: {
      _id: new ObjectId(),
      userId,
      accessTokenHash: 'access-hash',
      refreshTokenHash: 'refresh-hash',
      accessExpiresAt: new Date(now.getTime() + 60_000),
      refreshExpiresAt: new Date(now.getTime() + 120_000),
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    },
  };
}

async function buildMarketTestApp(
  deps?: Partial<MarketRouteDependencies>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerMarketRoutes, {
    prefix: '/api/market',
    deps,
  });
  return app;
}

test('market routes return 401 for unauthenticated requests', async () => {
  const app = await buildMarketTestApp({
    authenticateByAuthorizationHeader: async () => null,
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/market/occupation-insight?keyword=software%20developer',
    });

    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Unauthorized' });
  } finally {
    await app.close();
  }
});

test('market route rejects invalid query before provider work', async () => {
  let insightCalls = 0;
  const app = await buildMarketTestApp({
    authenticateByAuthorizationHeader: async () => buildFakeAuthContext(),
    getOccupationInsight: async () => {
      insightCalls += 1;
      return sampleInsight;
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/market/occupation-insight?keyword=x',
      headers: { authorization: 'Bearer test' },
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'Invalid market insight query');
    assert.equal(insightCalls, 0);
  } finally {
    await app.close();
  }
});

test('market route returns normalized occupation insight', async () => {
  let capturedQuery: unknown = null;
  const app = await buildMarketTestApp({
    authenticateByAuthorizationHeader: async () => buildFakeAuthContext(),
    getOccupationInsight: async (query) => {
      capturedQuery = query;
      return sampleInsight;
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/market/occupation-insight?keyword=software%20developer&refresh=true',
      headers: { authorization: 'Bearer test' },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(capturedQuery, {
      keyword: 'software developer',
      location: 'US',
      refresh: true,
    });
    assert.deepEqual(response.json(), sampleInsight);
  } finally {
    await app.close();
  }
});

test('market route maps provider errors to stable error codes', async () => {
  const app = await buildMarketTestApp({
    authenticateByAuthorizationHeader: async () => buildFakeAuthContext(),
    getOccupationInsight: async () => {
      throw new MarketProviderError('market_no_match', 'no match', 404);
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/market/occupation-insight?keyword=unknown%20role',
      headers: { authorization: 'Bearer test' },
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
