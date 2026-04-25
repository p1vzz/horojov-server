import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../services/auth.js';
import {
  registerAstrologyRoutes,
  type AstrologyRouteDependencies,
} from './astrology.js';
import {
  buildProfileHash,
  careerVibePlanQuerySchema,
  dailyTransitQuerySchema,
  discoverRolesQuerySchema,
  discoverRoleShortlistBodySchema,
  fullNatalAnalysisQuerySchema,
  natalChartRequestSchema,
  resolveBirthProfileEditPolicy,
} from '../services/astrology/astrologyShared.js';
import { statusForFullNatalGenerationCode } from '../services/astrology/astrologyPremiumAnalysisRoutes.js';

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
      method: "GET" | "PUT" | "POST" | "DELETE";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: "/api/astrology/birth-profile" },
      { method: "PUT", url: "/api/astrology/birth-profile", payload: {} },
      { method: "GET", url: "/api/astrology/daily-transit" },
      { method: "GET", url: "/api/astrology/career-vibe-plan" },
      { method: "GET", url: "/api/astrology/morning-briefing" },
      { method: "GET", url: "/api/astrology/full-natal-analysis" },
      { method: "GET", url: "/api/astrology/full-natal-analysis/progress" },
      { method: "GET", url: "/api/astrology/ai-synergy/history" },
      { method: "GET", url: "/api/astrology/career-insights" },
      { method: "GET", url: "/api/astrology/discover-roles" },
      { method: "GET", url: "/api/astrology/discover-roles/current-job" },
      {
        method: "PUT",
        url: "/api/astrology/discover-roles/current-job",
        payload: { title: "Product Manager" },
      },
      { method: "DELETE", url: "/api/astrology/discover-roles/current-job" },
      { method: "GET", url: "/api/astrology/discover-roles/shortlist" },
      {
        method: "PUT",
        url: "/api/astrology/discover-roles/shortlist/product-manager",
        payload: { role: "Product Manager" },
      },
      {
        method: "DELETE",
        url: "/api/astrology/discover-roles/shortlist/product-manager",
      },
      { method: "GET", url: "/api/astrology/market-career-context" },
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
      "/api/astrology/full-natal-analysis/progress",
      "/api/astrology/career-insights?tier=premium",
    ];

    for (const route of routes) {
      const response = await app.inject({
        method: "GET",
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

    const shortlist = await app.inject({
      method: "PUT",
      url: "/api/astrology/discover-roles/shortlist/product-manager",
      headers: { authorization: "Bearer test" },
      payload: {
        role: "",
        domain: "Product & Strategy",
      },
    });
    assert.equal(shortlist.statusCode, 400);
    assert.equal(shortlist.json().error, "Invalid shortlist payload");

    const currentJob = await app.inject({
      method: "PUT",
      url: "/api/astrology/discover-roles/current-job",
      headers: { authorization: "Bearer test" },
      payload: {
        title: "",
      },
    });
    assert.equal(currentJob.statusCode, 400);
    assert.equal(currentJob.json().error, "Invalid current job payload");

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

test("discover role shortlist body schema accepts persisted detail snapshots", () => {
  const parsed = discoverRoleShortlistBodySchema.parse({
    role: "Product Manager",
    domain: "Product & Strategy",
    scoreLabel: "91%",
    scoreValue: 91,
    tags: ["strategy", "execution"],
    market: null,
    detail: {
      whyFit: {
        summary: "Strong strategic fit.",
        bullets: ["Communication and prioritization matter."],
        topTraits: ["Communication"],
      },
      realityCheck: {
        summary: "Expect messy tradeoffs.",
        tasks: ["Align product bets."],
        workContext: ["Cross-functional teams."],
        toolThemes: ["Roadmapping"],
      },
      entryBarrier: {
        level: "moderate",
        label: "Moderate Entry Barrier",
        summary: "Adjacent product or ops proof helps.",
        signals: ["Portfolio and stakeholder judgment matter."],
      },
    },
  });

  assert.equal(parsed.role, "Product Manager");
  assert.deepEqual(parsed.detail, {
    whyFit: {
      summary: "Strong strategic fit.",
      bullets: ["Communication and prioritization matter."],
      topTraits: ["Communication"],
    },
    realityCheck: {
      summary: "Expect messy tradeoffs.",
      tasks: ["Align product bets."],
      workContext: ["Cross-functional teams."],
      toolThemes: ["Roadmapping"],
    },
    entryBarrier: {
      level: "moderate",
      label: "Moderate Entry Barrier",
      summary: "Adjacent product or ops proof helps.",
      signals: ["Portfolio and stakeholder judgment matter."],
    },
  });
});

test("discover roles query parses explicit false booleans as false", () => {
  const parsed = discoverRolesQuerySchema.parse({
    refresh: "false",
    deferSearchScores: "false",
  });

  assert.equal(parsed.refresh, false);
  assert.equal(parsed.deferSearchScores, false);
  assert.equal(parsed.rankingMode, "fit");

  const deferred = discoverRolesQuerySchema.parse({
    refresh: "true",
    deferSearchScores: "true",
    scoreSlug: "registered-nurse",
    rankingMode: "opportunity",
  });

  assert.equal(deferred.refresh, true);
  assert.equal(deferred.deferSearchScores, true);
  assert.equal(deferred.scoreSlug, "registered-nurse");
  assert.equal(deferred.rankingMode, "opportunity");
});

test("runtime astrology query booleans do not coerce string false to true", () => {
  const transit = dailyTransitQuerySchema.parse({
    includeAiSynergy: "false",
  });
  assert.equal(transit.includeAiSynergy, false);

  const transitWithSynergy = dailyTransitQuerySchema.parse({
    includeAiSynergy: "true",
  });
  assert.equal(transitWithSynergy.includeAiSynergy, true);

  const careerVibe = careerVibePlanQuerySchema.parse({
    refresh: "false",
  });
  assert.equal(careerVibe.refresh, false);

  const refreshedCareerVibe = careerVibePlanQuerySchema.parse({
    refresh: "true",
  });
  assert.equal(refreshedCareerVibe.refresh, true);
});

test("birth profile edit policy starts with one-day lock and blocks edits while active", () => {
  const now = new Date("2026-04-21T12:00:00.000Z");
  const initialProfile = {
    birthDate: "01/01/1990",
    birthTime: "08:30",
    unknownTime: false,
    city: "New York",
  };
  const nextProfile = {
    ...initialProfile,
    birthTime: "09:00",
  };
  const nextProfileHash = buildProfileHash(nextProfile);

  const firstPolicy = resolveBirthProfileEditPolicy(
    {
      profileHash: buildProfileHash(initialProfile),
    },
    nextProfileHash,
    now,
  );

  assert.equal(firstPolicy.changed, true);
  assert.equal(firstPolicy.blocked, false);
  assert.equal(firstPolicy.nextLock?.durationDays, 1);
  assert.equal(firstPolicy.nextLock?.lockLevel, 1);
  assert.equal(firstPolicy.nextLock?.lockedUntil.toISOString(), "2026-04-22T12:00:00.000Z");

  const blockedPolicy = resolveBirthProfileEditPolicy(
    {
      profileHash: nextProfileHash,
      birthEditLockDurationDays: firstPolicy.nextLock?.durationDays,
      birthEditLockLevel: firstPolicy.nextLock?.lockLevel,
      birthEditLockedUntil: firstPolicy.nextLock?.lockedUntil,
    },
    buildProfileHash({ ...nextProfile, birthTime: "10:00" }),
    new Date("2026-04-21T13:00:00.000Z"),
  );

  assert.equal(blockedPolicy.changed, true);
  assert.equal(blockedPolicy.blocked, true);
  assert.equal(blockedPolicy.lock.lockLevel, 1);
  assert.equal(blockedPolicy.lock.durationDays, 1);
  assert.equal(blockedPolicy.lock.lockedUntil?.toISOString(), "2026-04-22T12:00:00.000Z");
});

test("birth profile edit policy increments lock after prior lock expires", () => {
  const currentProfile = {
    birthDate: "01/01/1990",
    birthTime: "08:30",
    unknownTime: false,
    city: "New York",
  };
  const policy = resolveBirthProfileEditPolicy(
    {
      profileHash: buildProfileHash(currentProfile),
      birthEditLockDurationDays: 1,
      birthEditLockLevel: 1,
      birthEditLockedUntil: new Date("2026-04-20T12:00:00.000Z"),
    },
    buildProfileHash({ ...currentProfile, city: "Boston" }),
    new Date("2026-04-21T12:00:00.000Z"),
  );

  assert.equal(policy.changed, true);
  assert.equal(policy.blocked, false);
  assert.equal(policy.nextLock?.lockLevel, 2);
  assert.equal(policy.nextLock?.durationDays, 2);
  assert.equal(policy.nextLock?.lockedUntil.toISOString(), "2026-04-23T12:00:00.000Z");
});

test("birth profile edit policy does not lock initial profile or no-op updates", () => {
  const profile = {
    birthDate: "01/01/1990",
    birthTime: "08:30",
    unknownTime: false,
    city: "New York",
  };
  const profileHash = buildProfileHash(profile);

  const initialPolicy = resolveBirthProfileEditPolicy(null, profileHash, new Date("2026-04-21T12:00:00.000Z"));
  assert.equal(initialPolicy.changed, false);
  assert.equal(initialPolicy.blocked, false);
  assert.equal(initialPolicy.nextLock, null);

  const noOpPolicy = resolveBirthProfileEditPolicy(
    {
      profileHash,
      birthEditLockDurationDays: 1,
      birthEditLockLevel: 1,
      birthEditLockedUntil: new Date("2026-04-22T12:00:00.000Z"),
    },
    profileHash,
    new Date("2026-04-21T12:00:00.000Z"),
  );
  assert.equal(noOpPolicy.changed, false);
  assert.equal(noOpPolicy.blocked, false);
  assert.equal(noOpPolicy.nextLock, null);
});

test("birth profile hash ignores current job title and schema accepts it as optional metadata", () => {
  const baseProfile = {
    birthDate: "01/01/1990",
    birthTime: "08:30",
    unknownTime: false,
    city: "New York",
  };

  const withProductRole = natalChartRequestSchema.parse({
    ...baseProfile,
    currentJobTitle: "  Product Manager  ",
  });
  const withFounderRole = natalChartRequestSchema.parse({
    ...baseProfile,
    currentJobTitle: "Founder",
  });

  assert.equal(withProductRole.currentJobTitle, "Product Manager");
  assert.equal(buildProfileHash(withProductRole), buildProfileHash(withFounderRole));
});

test("full natal analysis query parses cache-only booleans explicitly", () => {
  const parsed = fullNatalAnalysisQuerySchema.parse({
    cacheOnly: "true",
  });

  assert.equal(parsed.cacheOnly, true);
});

test("full natal generation failure codes map to stable HTTP statuses", () => {
  assert.equal(statusForFullNatalGenerationCode("full_natal_llm_timeout"), 504);
  assert.equal(statusForFullNatalGenerationCode("full_natal_llm_rate_limited"), 503);
  assert.equal(statusForFullNatalGenerationCode("full_natal_llm_unavailable"), 503);
  assert.equal(statusForFullNatalGenerationCode("full_natal_llm_unconfigured"), 503);
  assert.equal(statusForFullNatalGenerationCode("full_natal_llm_invalid_response"), 502);
  assert.equal(statusForFullNatalGenerationCode("full_natal_llm_upstream_error"), 502);
});
