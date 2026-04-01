import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../services/auth.js';
import {
  registerAstrologyRoutes,
  type AstrologyRouteDependencies,
} from './astrology.js';

function buildFakeAuthContext(
  subscriptionTier: "free" | "premium",
): AuthContext {
  const userId = new ObjectId();
  const now = new Date();
  return {
    user: {
      _id: userId,
      kind: "anonymous",
      subscriptionTier,
      email: null,
      displayName: null,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    },
    session: {
      _id: new ObjectId(),
      userId,
      accessTokenHash: "access-hash",
      refreshTokenHash: "refresh-hash",
      accessExpiresAt: new Date(now.getTime() + 60_000),
      refreshExpiresAt: new Date(now.getTime() + 120_000),
      createdAt: now,
      updatedAt: now,
      revokedAt: null,
    },
  };
}

async function buildAstrologyTestApp(
  deps?: Partial<AstrologyRouteDependencies>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerAstrologyRoutes, {
    prefix: "/api/astrology",
    deps,
  });
  return app;
}

test("astrology routes return 401 for unauthenticated requests", async () => {
  const app = await buildAstrologyTestApp();

  try {
    const cases: Array<{
      method: "GET" | "PUT" | "POST";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: "/api/astrology/birth-profile" },
      { method: "PUT", url: "/api/astrology/birth-profile", payload: {} },
      { method: "GET", url: "/api/astrology/daily-transit" },
      { method: "GET", url: "/api/astrology/morning-briefing" },
      { method: "GET", url: "/api/astrology/full-natal-analysis" },
      { method: "POST", url: "/api/astrology/full-natal-analysis/regenerate" },
      { method: "GET", url: "/api/astrology/ai-synergy/history" },
      { method: "GET", url: "/api/astrology/career-insights" },
      { method: "GET", url: "/api/astrology/discover-roles" },
      { method: "POST", url: "/api/astrology/natal-chart", payload: {} },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        payload: testCase.payload,
      });

      assert.equal(
        response.statusCode,
        401,
        `${testCase.method} ${testCase.url}`,
      );
      assert.deepEqual(response.json(), { error: "Unauthorized" });
    }
  } finally {
    await app.close();
  }
});

test("premium endpoints return 403 for free users", async () => {
  const freeAuth = buildFakeAuthContext("free");
  const app = await buildAstrologyTestApp({
    authenticateByAuthorizationHeader: async () => freeAuth,
  });

  try {
    const routes = [
      "/api/astrology/morning-briefing",
      "/api/astrology/full-natal-analysis",
      "/api/astrology/full-natal-analysis/regenerate",
    ];

    for (const route of routes) {
      const response = await app.inject({
        method: route.endsWith("/regenerate") ? "POST" : "GET",
        url: route,
        headers: { authorization: "Bearer test" },
      });

      assert.equal(response.statusCode, 403, route);
      assert.deepEqual(response.json(), {
        error: "Premium required",
        code: "premium_required",
      });
    }
  } finally {
    await app.close();
  }
});

test("query and body validation fails before heavy astrology dependencies", async () => {
  const premiumAuth = buildFakeAuthContext("premium");
  const app = await buildAstrologyTestApp({
    authenticateByAuthorizationHeader: async () => premiumAuth,
  });

  try {
    const history = await app.inject({
      method: "GET",
      url: "/api/astrology/ai-synergy/history?days=0",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(history.statusCode, 400);
    assert.equal(history.json().error, "Invalid query parameters");

    const career = await app.inject({
      method: "GET",
      url: "/api/astrology/career-insights?tier=invalid",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(career.statusCode, 400);
    assert.equal(career.json().error, "Invalid query parameters");

    const discover = await app.inject({
      method: "GET",
      url: "/api/astrology/discover-roles?limit=99",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(discover.statusCode, 400);
    assert.equal(discover.json().error, "Invalid query parameters");

    const birthProfile = await app.inject({
      method: "PUT",
      url: "/api/astrology/birth-profile",
      headers: { authorization: "Bearer test" },
      payload: {},
    });
    assert.equal(birthProfile.statusCode, 400);
    assert.equal(birthProfile.json().error, "Invalid request payload");
  } finally {
    await app.close();
  }
});
