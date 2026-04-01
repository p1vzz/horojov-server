import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../src/services/auth.js';
import { registerAstrologyRoutes } from '../src/routes/astrology.js';
import { registerAuthRoutes } from '../src/routes/auth.js';
import { registerBillingRoutes } from '../src/routes/billing.js';
import { registerHealthRoutes } from '../src/routes/health.js';
import { registerJobRoutes } from '../src/routes/jobs.handlers.js';
import { registerNotificationRoutes } from '../src/routes/notifications.js';

function buildAuthContext(subscriptionTier: 'free' | 'premium' = 'premium'): AuthContext {
  const userId = new ObjectId();
  const now = new Date();
  return {
    user: {
      _id: userId,
      kind: 'anonymous',
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

function authResolver(context: AuthContext) {
  return async (authorization?: string) => {
    if (!authorization || !authorization.toLowerCase().startsWith('bearer ')) return null;
    return context;
  };
}

async function smokeHealthRoute() {
  const app = Fastify();
  await app.register(registerHealthRoutes);
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { status: 'ok' });
  } finally {
    await app.close();
  }
}

async function smokeAuthRoutes() {
  const auth = buildAuthContext('premium');
  let revokeByAccessCalls = 0;
  let revokeByRefreshCalls = 0;

  const app = Fastify();
  await app.register(registerAuthRoutes, {
    prefix: '/api/auth',
    deps: {
      authenticateByAuthorizationHeader: authResolver(auth),
      createAnonymousSession: async () => ({
        user: auth.user,
        tokens: {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
      }),
      rotateSessionByRefreshToken: async () => ({
        user: auth.user,
        tokens: {
          accessToken: 'access-token-2',
          refreshToken: 'refresh-token-2',
          accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
        },
      }),
      linkAppleIdentityToUser: async () => ({
        ok: true,
        user: auth.user,
      }),
      revokeSessionByAccessHeader: async () => {
        revokeByAccessCalls += 1;
      },
      revokeSessionByRefreshToken: async () => {
        revokeByRefreshCalls += 1;
      },
    },
  });

  try {
    const anonymousResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/anonymous',
    });
    assert.equal(anonymousResponse.statusCode, 201);

    const meUnauthorized = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
    });
    assert.equal(meUnauthorized.statusCode, 401);

    const refreshInvalid = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: 'short' },
    });
    assert.equal(refreshInvalid.statusCode, 400);

    const refreshOk = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: { refreshToken: 'x'.repeat(24) },
    });
    assert.equal(refreshOk.statusCode, 200);

    const appleLinkOk = await app.inject({
      method: 'POST',
      url: '/api/auth/apple-link',
      headers: { authorization: 'Bearer smoke' },
      payload: { appleSub: 'apple-sub-smoke-12345' },
    });
    assert.equal(appleLinkOk.statusCode, 200);

    const logoutOk = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { authorization: 'Bearer smoke' },
      payload: { refreshToken: 'x'.repeat(24) },
    });
    assert.equal(logoutOk.statusCode, 204);
    assert.equal(revokeByAccessCalls, 1);
    assert.equal(revokeByRefreshCalls, 1);
  } finally {
    await app.close();
  }
}

async function smokeAstrologyRoutes() {
  const app = Fastify();
  await app.register(registerAstrologyRoutes, {
    prefix: '/api/astrology',
    deps: {
      authenticateByAuthorizationHeader: async () => null,
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/astrology/birth-profile',
    });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
}

async function smokeJobRoutes() {
  const auth = buildAuthContext('premium');
  const app = Fastify();
  await app.register(registerJobRoutes, {
    prefix: '/api/jobs',
    deps: {
      authenticateByAuthorizationHeader: authResolver(auth),
      resolveUserUsagePlan: () => 'premium',
      getCurrentUsageLimitState: async () => ({
        plan: 'premium',
        period: 'daily_utc',
        limit: 10,
        used: 0,
        remaining: 10,
        nextAvailableAt: null,
        canProceed: true,
      }),
      collectJobMetrics: async () => ({
        window: {
          hours: 24,
          from: new Date('2026-03-30T00:00:00.000Z').toISOString(),
          to: new Date('2026-03-30T01:00:00.000Z').toISOString(),
        },
        totals: {
          rawFetches: 0,
          negativeEvents: 0,
          parsedDocs: 0,
        },
        sources: [],
      }),
      evaluateJobMetricsAlerts: (metrics) => ({
        generatedAt: new Date('2026-03-30T01:00:00.000Z').toISOString(),
        window: metrics.window,
        thresholds: {
          minEvents: 5,
          blockedRatePct: 20,
          browserFallbackRatePct: 20,
          successRateMinPct: 60,
        },
        hasAlerts: false,
        alerts: [],
      }),
      handleJobPreflight: async () => ({ ok: true, stage: 'preflight' }),
      handleJobAnalyzeScreenshots: async () => ({ ok: true, stage: 'screenshots' }),
      handleJobAnalyze: async () => ({ ok: true, stage: 'analyze' }),
    },
  });

  try {
    const unauthorized = await app.inject({
      method: 'GET',
      url: '/api/jobs/limits',
    });
    assert.equal(unauthorized.statusCode, 401);

    const metricsInvalid = await app.inject({
      method: 'GET',
      url: '/api/jobs/metrics?windowHours=0',
      headers: { authorization: 'Bearer smoke' },
    });
    assert.equal(metricsInvalid.statusCode, 400);

    const preflightOk = await app.inject({
      method: 'POST',
      url: '/api/jobs/preflight',
      headers: { authorization: 'Bearer smoke' },
      payload: { url: 'https://www.linkedin.com/jobs/view/1234567890/' },
    });
    assert.equal(preflightOk.statusCode, 200);
  } finally {
    await app.close();
  }
}

async function smokeBillingRoutes() {
  const auth = buildAuthContext('premium');
  const app = Fastify();
  await app.register(registerBillingRoutes, {
    prefix: '/api/billing',
    deps: {
      authenticateByAuthorizationHeader: authResolver(auth),
      expectedWebhookAuthorization: () => 'Bearer rc-smoke-token',
      getBillingSnapshotForUser: async () =>
        ({
          tier: 'premium',
          status: 'active',
          provider: 'revenuecat',
          source: 'sync',
        }) as never,
      syncRevenueCatForUser: async () =>
        ({
          user: auth.user,
          subscription: {
            tier: 'premium',
            status: 'active',
            provider: 'revenuecat',
            source: 'sync',
          },
        }) as never,
      syncRevenueCatForAppUserId: async () =>
        ({
          user: auth.user,
        }) as never,
      getCollections: async () =>
        ({
          revenueCatEvents: {
            findOne: async () => null,
            insertOne: async () => ({ acknowledged: true }),
            updateOne: async () => ({ matchedCount: 1 }),
          },
        }) as never,
    },
  });

  try {
    const subscriptionUnauthorized = await app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
    });
    assert.equal(subscriptionUnauthorized.statusCode, 401);

    const subscriptionOk = await app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      headers: { authorization: 'Bearer smoke' },
    });
    assert.equal(subscriptionOk.statusCode, 200);

    const webhookUnauthorized = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      headers: { authorization: 'Bearer wrong' },
      payload: { event: { id: 'evt_wrong' } },
    });
    assert.equal(webhookUnauthorized.statusCode, 401);

    const webhookOk = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      headers: { authorization: 'Bearer rc-smoke-token' },
      payload: {
        event: {
          id: 'evt_smoke',
          type: 'INITIAL_PURCHASE',
          app_user_id: 'smoke-user',
        },
      },
    });
    assert.equal(webhookOk.statusCode, 200);
    assert.deepEqual(webhookOk.json(), { ok: true, status: 'processed' });
  } finally {
    await app.close();
  }
}

async function smokeNotificationRoutes() {
  const freeAuth = buildAuthContext('free');
  const premiumAuth = buildAuthContext('premium');

  const freeApp = Fastify();
  await freeApp.register(registerNotificationRoutes, {
    prefix: '/api/notifications',
    deps: {
      authenticateByAuthorizationHeader: authResolver(freeAuth),
    },
  });

  try {
    const response = await freeApp.inject({
      method: 'GET',
      url: '/api/notifications/lunar-productivity-plan',
      headers: { authorization: 'Bearer smoke' },
    });
    assert.equal(response.statusCode, 403);
  } finally {
    await freeApp.close();
  }

  const premiumApp = Fastify();
  await premiumApp.register(registerNotificationRoutes, {
    prefix: '/api/notifications',
    deps: {
      authenticateByAuthorizationHeader: authResolver(premiumAuth),
      isValidIanaTimezone: () => true,
      upsertPushNotificationTokenForUser: async () => ({
        platform: 'ios',
        active: true,
        updatedAt: new Date('2026-03-30T00:00:00.000Z'),
        lastSeenAt: new Date('2026-03-30T00:00:00.000Z'),
      }),
      getBurnoutAlertSettingsForUser: async () => ({
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
        updatedAt: null,
        source: 'default',
      }),
      getLatestBurnoutAlertJobForUser: async () => null,
      getLunarProductivitySettingsForUser: async () => ({
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
        updatedAt: null,
        source: 'default',
      }),
      getLatestLunarProductivityJobForUser: async () => null,
      getOrCreateDailyTransitForUser: async () =>
        ({
          doc: { dateKey: '2026-03-30' },
        }) as never,
      calculateBurnoutRisk: () =>
        ({
          algorithmVersion: 'burnout-risk-v1',
          riskScore: 62,
          severity: 'warn',
          components: {
            saturnLoad: 20,
            moonLoad: 15,
            workloadMismatch: 8,
            tagPressure: 7,
            recoveryBuffer: 10,
          },
          signals: {
            saturnHardCount: 1,
            moonHardCount: 1,
            saturnMoonHard: 0.5,
            riskTagContextSwitch: 20,
            riskTagRushBias: 20,
            positiveAspectStrength: 12,
            momentum: { energy: 3, focus: -2 },
            saturn: { house: 10, retrograde: false },
            moon: { house: 6 },
          },
        }) as never,
      calculateLunarProductivityRisk: () =>
        ({
          algorithmVersion: 'lunar-productivity-risk-v1',
          riskScore: 70,
          severity: 'high',
          components: {
            moonPhaseLoad: 10,
            emotionalTide: 9,
            focusResonance: 8,
            circadianAlignment: 7,
            recoveryBuffer: 6,
          },
          signals: {
            moonPhase: 'full_moon',
            illuminationPercent: 95,
            moonHouse: 6,
            hardAspectCount: 2,
            supportiveAspectStrength: 15,
            momentum: { energy: 8, focus: -3 },
          },
        }) as never,
      upsertBurnoutAlertSettingsForUser: async () => ({
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
        updatedAt: null,
        source: 'saved',
      }),
      upsertLunarProductivitySettingsForUser: async () => ({
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
        updatedAt: null,
        source: 'saved',
      }),
      upsertInterviewStrategySettingsForUser: async () =>
        ({
          enabled: true,
          timezoneIana: 'Europe/Warsaw',
          slotDurationMinutes: 60,
          allowedWeekdays: [1, 2, 3],
          workdayStartMinute: 540,
          workdayEndMinute: 1080,
          quietHoursStartMinute: 1290,
          quietHoursEndMinute: 480,
          slotsPerWeek: 3,
          autoFillConfirmedAt: null,
          autoFillStartAt: null,
          filledUntilDateKey: null,
          lastGeneratedAt: null,
          updatedAt: null,
          source: 'saved',
        }) as never,
      maybeRefillInterviewStrategyWindowForUser: async () =>
        ({
          status: 'noop',
        }) as never,
      rebuildInterviewStrategyWindowForUser: async () =>
        ({
          status: 'generated',
        }) as never,
      fetchInterviewStrategyPlanForUser: async () =>
        ({
          enabled: true,
          settings: {
            enabled: true,
            timezoneIana: 'Europe/Warsaw',
            slotDurationMinutes: 60,
            allowedWeekdays: [1, 2, 3],
            workdayStartMinute: 540,
            workdayEndMinute: 1080,
            quietHoursStartMinute: 1290,
            quietHoursEndMinute: 480,
            slotsPerWeek: 3,
            autoFillConfirmedAt: null,
            autoFillStartAt: null,
            filledUntilDateKey: null,
            lastGeneratedAt: null,
            updatedAt: null,
            source: 'saved',
          },
          plan: {
            generatedAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
            algorithmVersion: 'interview-strategy-v1',
            timezoneIana: 'Europe/Warsaw',
            slots: [],
            filledUntilDateKey: null,
          },
        }) as never,
    },
  });

  try {
    const unauthorized = await premiumApp.inject({
      method: 'PUT',
      url: '/api/notifications/push-token',
      payload: {
        token: 'x'.repeat(32),
        platform: 'ios',
      },
    });
    assert.equal(unauthorized.statusCode, 401);

    const burnoutPlan = await premiumApp.inject({
      method: 'GET',
      url: '/api/notifications/burnout-plan',
      headers: { authorization: 'Bearer smoke' },
    });
    assert.equal(burnoutPlan.statusCode, 200);

    const lunarPlan = await premiumApp.inject({
      method: 'GET',
      url: '/api/notifications/lunar-productivity-plan',
      headers: { authorization: 'Bearer smoke' },
    });
    assert.equal(lunarPlan.statusCode, 200);
    assert.equal(lunarPlan.json().risk.algorithmVersion, 'lunar-productivity-risk-v1');

    const strategyPlan = await premiumApp.inject({
      method: 'GET',
      url: '/api/notifications/interview-strategy-plan?refresh=true',
      headers: { authorization: 'Bearer smoke' },
    });
    assert.equal(strategyPlan.statusCode, 200);
  } finally {
    await premiumApp.close();
  }
}

async function run() {
  const checks: Array<{
    name: string;
    run: () => Promise<void>;
  }> = [
    { name: 'health', run: smokeHealthRoute },
    { name: 'auth', run: smokeAuthRoutes },
    { name: 'astrology', run: smokeAstrologyRoutes },
    { name: 'jobs', run: smokeJobRoutes },
    { name: 'billing', run: smokeBillingRoutes },
    { name: 'notifications', run: smokeNotificationRoutes },
  ];

  for (const check of checks) {
    await check.run();
    console.log(`[smoke] ${check.name} ok`);
  }

  console.log('[smoke] all route checks passed');
}

run().catch((error) => {
  console.error('[smoke] route checks failed');
  console.error(error);
  process.exit(1);
});
