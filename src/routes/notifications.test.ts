import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../services/auth.js';
import { registerNotificationRoutes, type NotificationRouteDependencies } from './notifications.js';

function buildFakeAuthContext(subscriptionTier: 'free' | 'premium' = 'free'): AuthContext {
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

async function buildNotificationsTestApp(
  deps?: Partial<NotificationRouteDependencies>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerNotificationRoutes, {
    prefix: '/api/notifications',
    deps,
  });
  return app;
}

test('notification routes return 401 for unauthenticated requests', async () => {
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => null,
  });

  try {
    const cases: Array<{
      method: 'PUT' | 'GET' | 'POST';
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: 'PUT', url: '/api/notifications/push-token', payload: { token: 'x'.repeat(32), platform: 'ios' } },
      { method: 'PUT', url: '/api/notifications/burnout-settings', payload: { enabled: true } },
      { method: 'GET', url: '/api/notifications/burnout-plan' },
      { method: 'POST', url: '/api/notifications/burnout-seen', payload: { dateKey: '2026-03-30' } },
      { method: 'PUT', url: '/api/notifications/lunar-productivity-settings', payload: { enabled: true } },
      { method: 'GET', url: '/api/notifications/lunar-productivity-plan' },
      { method: 'POST', url: '/api/notifications/lunar-productivity-seen', payload: { dateKey: '2026-03-30' } },
      { method: 'PUT', url: '/api/notifications/interview-strategy-settings', payload: { enabled: true } },
      { method: 'GET', url: '/api/notifications/interview-strategy-plan' },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        payload: testCase.payload,
      });
      assert.equal(response.statusCode, 401, `${testCase.method} ${testCase.url}`);
      assert.deepEqual(response.json(), { error: 'Unauthorized' });
    }
  } finally {
    await app.close();
  }
});

test('premium-only notification routes return 403 for free users', async () => {
  const auth = buildFakeAuthContext('free');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
  });

  try {
    const cases: Array<{
      method: 'PUT' | 'GET' | 'POST';
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      {
        method: 'PUT',
        url: '/api/notifications/burnout-settings',
        payload: {
          enabled: true,
          timezoneIana: 'Europe/Warsaw',
          workdayStartMinute: 540,
          workdayEndMinute: 1080,
          quietHoursStartMinute: 1290,
          quietHoursEndMinute: 480,
        },
      },
      { method: 'GET', url: '/api/notifications/burnout-plan' },
      {
        method: 'POST',
        url: '/api/notifications/burnout-seen',
        payload: {
          dateKey: '2026-03-30',
        },
      },
      {
        method: 'PUT',
        url: '/api/notifications/lunar-productivity-settings',
        payload: {
          enabled: true,
          timezoneIana: 'Europe/Warsaw',
          workdayStartMinute: 540,
          workdayEndMinute: 1080,
          quietHoursStartMinute: 1290,
          quietHoursEndMinute: 480,
        },
      },
      { method: 'GET', url: '/api/notifications/lunar-productivity-plan' },
      {
        method: 'POST',
        url: '/api/notifications/lunar-productivity-seen',
        payload: {
          dateKey: '2026-03-30',
        },
      },
      {
        method: 'PUT',
        url: '/api/notifications/interview-strategy-settings',
        payload: {
          enabled: true,
          timezoneIana: 'Europe/Warsaw',
          slotDurationMinutes: 60,
          allowedWeekdays: [1, 2, 3],
          workdayStartMinute: 540,
          workdayEndMinute: 1080,
          quietHoursStartMinute: 1290,
          quietHoursEndMinute: 480,
          slotsPerWeek: 3,
        },
      },
      { method: 'GET', url: '/api/notifications/interview-strategy-plan' },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: {
          authorization: 'Bearer test',
        },
        payload: testCase.payload,
      });
      assert.equal(response.statusCode, 403, `${testCase.method} ${testCase.url}`);
      assert.deepEqual(response.json(), { error: 'Premium required', code: 'premium_required' });
    }
  } finally {
    await app.close();
  }
});

test('notification validation rejects invalid payload/query before heavy dependencies', async () => {
  const auth = buildFakeAuthContext('premium');
  let lunarSettingsUpsertCalls = 0;
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    isValidIanaTimezone: () => false,
    upsertLunarProductivitySettingsForUser: async () => {
      lunarSettingsUpsertCalls += 1;
      return {
        enabled: false,
        timezoneIana: 'UTC',
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
        updatedAt: null,
        source: 'default',
      };
    },
  });

  try {
    const pushPayloadResponse = await app.inject({
      method: 'PUT',
      url: '/api/notifications/push-token',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        token: 'short',
        platform: 'ios',
      },
    });
    assert.equal(pushPayloadResponse.statusCode, 400);
    assert.equal(pushPayloadResponse.json().error, 'Invalid push token payload');

    const burnoutTimezoneResponse = await app.inject({
      method: 'PUT',
      url: '/api/notifications/burnout-settings',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        enabled: true,
        timezoneIana: 'invalid/timezone',
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
      },
    });
    assert.equal(burnoutTimezoneResponse.statusCode, 400);
    assert.equal(burnoutTimezoneResponse.json().error, 'Invalid burnout settings payload');

    const burnoutSeenPayloadResponse = await app.inject({
      method: 'POST',
      url: '/api/notifications/burnout-seen',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        dateKey: '2026/03/30',
      },
    });
    assert.equal(burnoutSeenPayloadResponse.statusCode, 400);
    assert.equal(burnoutSeenPayloadResponse.json().error, 'Invalid burnout seen payload');

    const lunarTimezoneResponse = await app.inject({
      method: 'PUT',
      url: '/api/notifications/lunar-productivity-settings',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        enabled: true,
        timezoneIana: 'invalid/timezone',
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
      },
    });
    assert.equal(lunarTimezoneResponse.statusCode, 400);
    assert.equal(lunarTimezoneResponse.json().error, 'Invalid lunar productivity settings payload');
    assert.equal(lunarSettingsUpsertCalls, 0);

    const interviewQueryResponse = await app.inject({
      method: 'GET',
      url: '/api/notifications/interview-strategy-plan?refresh=invalid',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(interviewQueryResponse.statusCode, 400);
    assert.equal(interviewQueryResponse.json().error, 'Invalid interview strategy query');
  } finally {
    await app.close();
  }
});

test('lunar productivity plan returns expected contract payload', async () => {
  const auth = buildFakeAuthContext('premium');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getLunarProductivitySettingsForUser: async () => ({
      enabled: true,
      timezoneIana: 'Europe/Warsaw',
      workdayStartMinute: 540,
      workdayEndMinute: 1080,
      quietHoursStartMinute: 1290,
      quietHoursEndMinute: 480,
      updatedAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
      source: 'saved',
    }),
    getLatestLunarProductivityJobForUser: async () => ({
      _id: new ObjectId(),
      userId: auth.user._id,
      profileHash: 'profile-current',
      dateKey: '2026-03-30',
      severity: 'high',
      riskScore: 72,
      predictedDipAt: new Date('2026-03-30T10:20:00.000Z'),
      scheduledAt: new Date('2026-03-30T09:25:00.000Z'),
      status: 'planned',
      providerMessageId: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-03-30T00:00:00.000Z'),
      updatedAt: new Date('2026-03-30T00:00:00.000Z'),
    }),
    getOrCreateDailyTransitForUser: async () =>
      ({
        doc: {
          profileHash: 'profile-current',
          dateKey: '2026-03-30',
          generatedAt: new Date('2026-03-30T00:00:00.000Z'),
        },
      }) as never,
    calculateLunarProductivityRisk: () => ({
      algorithmVersion: 'lunar-productivity-risk-v1',
      riskScore: 72,
      severity: 'high',
      components: {
        moonPhaseLoad: 15,
        emotionalTide: 8.5,
        focusResonance: 9.2,
        circadianAlignment: 21.1,
        recoveryBuffer: 12.4,
      },
      signals: {
        moonPhase: 'full_moon',
        illuminationPercent: 99.4,
        moonHouse: 6,
        hardAspectCount: 2.4,
        supportiveAspectStrength: 17.7,
        momentum: {
          energy: 9.8,
          focus: -4.2,
        },
      },
    }),
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/lunar-productivity-plan',
      headers: {
        authorization: 'Bearer test',
      },
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.dateKey, '2026-03-30');
    assert.equal(payload.enabled, true);
    assert.equal(payload.risk.algorithmVersion, 'lunar-productivity-risk-v1');
    assert.equal(payload.risk.score, 72);
    assert.equal(payload.risk.severity, 'high');
    assert.equal(payload.risk.impactDirection, null);
    assert.equal(payload.timing.algorithmVersion, 'lunar-productivity-timing-v1');
    assert.equal(payload.timing.status, 'planned');
    assert.equal(payload.timing.scheduledDateKey, '2026-03-30');
    assert.equal(payload.timing.scheduledSeverity, 'high');
    assert.equal(payload.timing.nextPlannedAt, '2026-03-30T09:25:00.000Z');
  } finally {
    await app.close();
  }
});

test('lunar productivity plan ignores stale same-day timing after birth profile changes', async () => {
  const auth = buildFakeAuthContext('premium');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getLunarProductivitySettingsForUser: async () => ({
      enabled: true,
      timezoneIana: 'Europe/Warsaw',
      workdayStartMinute: 540,
      workdayEndMinute: 1080,
      quietHoursStartMinute: 1290,
      quietHoursEndMinute: 480,
      updatedAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
      source: 'saved',
    }),
    getLatestLunarProductivityJobForUser: async () => ({
      _id: new ObjectId(),
      userId: auth.user._id,
      dateKey: '2026-03-30',
      severity: 'warn',
      riskScore: 18,
      predictedDipAt: new Date('2026-03-30T10:20:00.000Z'),
      scheduledAt: null,
      status: 'cancelled',
      providerMessageId: null,
      lastError: 'viewed_in_app',
      sentAt: null,
      seenAt: new Date('2026-03-30T08:00:00.000Z'),
      createdAt: new Date('2026-03-30T08:00:00.000Z'),
      updatedAt: new Date('2026-03-30T08:00:00.000Z'),
    }),
    getOrCreateDailyTransitForUser: async () =>
      ({
        doc: {
          profileHash: 'profile-after-onboarding',
          dateKey: '2026-03-30',
          generatedAt: new Date('2026-03-30T09:00:00.000Z'),
        },
      }) as never,
    calculateLunarProductivityRisk: () => ({
      algorithmVersion: 'lunar-productivity-risk-v1',
      riskScore: 19,
      severity: 'none',
      components: {
        moonPhaseLoad: 8,
        emotionalTide: 5,
        focusResonance: 6,
        circadianAlignment: 7,
        recoveryBuffer: 24,
      },
      signals: {
        moonPhase: 'waxing_gibbous',
        illuminationPercent: 68,
        moonHouse: 6,
        hardAspectCount: 1.1,
        supportiveAspectStrength: 22.4,
        momentum: {
          energy: 39,
          focus: 31,
        },
      },
    }),
    resolveLunarProductivityImpactDirection: () => 'supportive',
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/lunar-productivity-plan',
      headers: {
        authorization: 'Bearer test',
      },
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.risk.score, 19);
    assert.equal(payload.risk.impactDirection, 'supportive');
    assert.equal(payload.timing.status, 'not_scheduled');
    assert.equal(payload.timing.nextPlannedAt, null);
    assert.equal(payload.timing.scheduledDateKey, null);
    assert.equal(payload.timing.scheduledSeverity, null);
  } finally {
    await app.close();
  }
});

test('lunar productivity seen acknowledges current-day in-range card and cancels pending timing', async () => {
  const auth = buildFakeAuthContext('premium');
  let markSeenCalls = 0;
  const markSeenInputs: Array<Parameters<NotificationRouteDependencies['markLunarProductivityJobSeenForUser']>[0]> = [];
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getOrCreateDailyTransitForUser: async () =>
      ({
        doc: {
          profileHash: 'profile-current',
          dateKey: '2026-03-30',
          generatedAt: new Date('2026-03-30T07:00:00.000Z'),
        },
      }) as never,
    calculateLunarProductivityRisk: () => ({
      algorithmVersion: 'lunar-productivity-risk-v1',
      riskScore: 18,
      severity: 'none',
      components: {
        moonPhaseLoad: 8,
        emotionalTide: 5,
        focusResonance: 6,
        circadianAlignment: 7,
        recoveryBuffer: 24,
      },
      signals: {
        moonPhase: 'waxing_gibbous',
        illuminationPercent: 68,
        moonHouse: 6,
        hardAspectCount: 1.1,
        supportiveAspectStrength: 22.4,
        momentum: {
          energy: 39,
          focus: 31,
        },
      },
    }),
    resolveLunarProductivityImpactDirection: () => 'supportive',
    resolveLunarProductivityPushSeverity: () => 'warn',
    markLunarProductivityJobSeenForUser: async (input) => {
      markSeenCalls += 1;
      markSeenInputs.push(input);
      return {
        status: 'cancelled',
        job: null,
      };
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/lunar-productivity-seen',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        dateKey: '2026-03-30',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      acknowledged: true,
      reason: null,
      dateKey: '2026-03-30',
      impactDirection: 'supportive',
      timingStatus: 'cancelled',
    });
    assert.equal(markSeenCalls, 1);
    const markSeenInput = markSeenInputs[0];
    assert.ok(markSeenInput);
    assert.equal(markSeenInput.profileHash, 'profile-current');
    assert.deepEqual(markSeenInput.transitGeneratedAt, new Date('2026-03-30T07:00:00.000Z'));
  } finally {
    await app.close();
  }
});

test('lunar productivity plan suppresses timing when alerts are disabled', async () => {
  const auth = buildFakeAuthContext('premium');
  let latestJobCalls = 0;
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getLunarProductivitySettingsForUser: async () => ({
      enabled: false,
      timezoneIana: 'Europe/Warsaw',
      workdayStartMinute: 540,
      workdayEndMinute: 1080,
      quietHoursStartMinute: 1290,
      quietHoursEndMinute: 480,
      updatedAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
      source: 'saved',
    }),
    getLatestLunarProductivityJobForUser: async () => {
      latestJobCalls += 1;
      return {
        _id: new ObjectId(),
        userId: auth.user._id,
        dateKey: '2026-03-30',
        severity: 'high',
        riskScore: 72,
        predictedDipAt: new Date('2026-03-30T10:20:00.000Z'),
        scheduledAt: new Date('2026-03-30T09:25:00.000Z'),
        status: 'planned',
        providerMessageId: null,
        lastError: null,
        sentAt: null,
        createdAt: new Date('2026-03-30T00:00:00.000Z'),
        updatedAt: new Date('2026-03-30T00:00:00.000Z'),
      };
    },
    getOrCreateDailyTransitForUser: async () =>
      ({
        doc: {
          dateKey: '2026-03-30',
        },
      }) as never,
    calculateLunarProductivityRisk: () => ({
      algorithmVersion: 'lunar-productivity-risk-v1',
      riskScore: 72,
      severity: 'high',
      components: {
        moonPhaseLoad: 15,
        emotionalTide: 8.5,
        focusResonance: 9.2,
        circadianAlignment: 21.1,
        recoveryBuffer: 12.4,
      },
      signals: {
        moonPhase: 'full_moon',
        illuminationPercent: 99.4,
        moonHouse: 6,
        hardAspectCount: 2.4,
        supportiveAspectStrength: 17.7,
        momentum: {
          energy: 9.8,
          focus: -4.2,
        },
      },
    }),
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/lunar-productivity-plan',
      headers: {
        authorization: 'Bearer test',
      },
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.enabled, false);
    assert.equal(payload.timing.status, 'not_scheduled');
    assert.equal(payload.timing.nextPlannedAt, null);
    assert.equal(payload.timing.scheduledDateKey, null);
    assert.equal(payload.timing.scheduledSeverity, null);
    assert.equal(latestJobCalls, 0);
  } finally {
    await app.close();
  }
});

test('lunar productivity plan maps missing profile error to 404', async () => {
  const auth = buildFakeAuthContext('premium');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getLunarProductivitySettingsForUser: async () => ({
      enabled: false,
      timezoneIana: 'Europe/Warsaw',
      workdayStartMinute: 540,
      workdayEndMinute: 1080,
      quietHoursStartMinute: 1290,
      quietHoursEndMinute: 480,
      updatedAt: null,
      source: 'default',
    }),
    getLatestLunarProductivityJobForUser: async () => null,
    getOrCreateDailyTransitForUser: async () => {
      throw new Error('Birth profile not found. Complete onboarding first.');
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/lunar-productivity-plan',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: 'Birth profile not found. Complete onboarding first.',
    });
  } finally {
    await app.close();
  }
});

test('burnout plan returns expected contract payload', async () => {
  const auth = buildFakeAuthContext('premium');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getBurnoutAlertSettingsForUser: async () => ({
      enabled: true,
      timezoneIana: 'Europe/Warsaw',
      workdayStartMinute: 540,
      workdayEndMinute: 1080,
      quietHoursStartMinute: 1290,
      quietHoursEndMinute: 480,
      updatedAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
      source: 'saved',
    }),
    getLatestBurnoutAlertJobForUser: async () => ({
      _id: new ObjectId(),
      userId: auth.user._id,
      profileHash: 'profile-current',
      dateKey: '2026-03-30',
      severity: 'critical',
      riskScore: 88,
      predictedPeakAt: new Date('2026-03-30T14:00:00.000Z'),
      scheduledAt: new Date('2026-03-30T12:30:00.000Z'),
      status: 'planned',
      providerMessageId: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-03-30T00:00:00.000Z'),
      updatedAt: new Date('2026-03-30T00:00:00.000Z'),
    }),
    getOrCreateDailyTransitForUser: async () =>
      ({
        doc: {
          profileHash: 'profile-current',
          dateKey: '2026-03-30',
          generatedAt: new Date('2026-03-30T00:00:00.000Z'),
        },
      }) as never,
    calculateBurnoutRisk: () =>
      ({
        algorithmVersion: 'burnout-risk-v1',
        riskScore: 88,
        severity: 'critical',
        components: {
          saturnLoad: 30.2,
          moonLoad: 19.4,
          workloadMismatch: 8.2,
          tagPressure: 15.7,
          recoveryBuffer: 9.5,
        },
        signals: {
          saturnHardCount: 2.2,
          moonHardCount: 2.8,
          saturnMoonHard: 0.9,
          riskTagContextSwitch: 80,
          riskTagRushBias: 65,
          positiveAspectStrength: 14.1,
          momentum: {
            energy: 12.4,
            focus: -7.2,
          },
          saturn: {
            house: 10,
            retrograde: true,
          },
          moon: {
            house: 6,
          },
        },
      }) as never,
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/burnout-plan',
      headers: {
        authorization: 'Bearer test',
      },
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.dateKey, '2026-03-30');
    assert.equal(payload.risk.algorithmVersion, 'burnout-risk-v1');
    assert.equal(payload.risk.score, 88);
    assert.equal(payload.risk.severity, 'critical');
    assert.equal(payload.timing.algorithmVersion, 'burnout-timing-v1');
    assert.equal(payload.timing.status, 'planned');
    assert.equal(payload.timing.scheduledDateKey, '2026-03-30');
    assert.equal(payload.timing.scheduledSeverity, 'critical');
    assert.equal(payload.timing.nextPlannedAt, '2026-03-30T12:30:00.000Z');
  } finally {
    await app.close();
  }
});

test('burnout plan ignores stale same-day timing after birth profile changes', async () => {
  const auth = buildFakeAuthContext('premium');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getBurnoutAlertSettingsForUser: async () => ({
      enabled: true,
      timezoneIana: 'Europe/Warsaw',
      workdayStartMinute: 540,
      workdayEndMinute: 1080,
      quietHoursStartMinute: 1290,
      quietHoursEndMinute: 480,
      updatedAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
      source: 'saved',
    }),
    getLatestBurnoutAlertJobForUser: async () => ({
      _id: new ObjectId(),
      userId: auth.user._id,
      dateKey: '2026-03-30',
      severity: 'critical',
      riskScore: 88,
      predictedPeakAt: new Date('2026-03-30T14:00:00.000Z'),
      scheduledAt: new Date('2026-03-30T12:30:00.000Z'),
      status: 'planned',
      providerMessageId: null,
      lastError: null,
      sentAt: null,
      createdAt: new Date('2026-03-30T08:00:00.000Z'),
      updatedAt: new Date('2026-03-30T08:00:00.000Z'),
    }),
    getOrCreateDailyTransitForUser: async () =>
      ({
        doc: {
          profileHash: 'profile-after-onboarding',
          dateKey: '2026-03-30',
          generatedAt: new Date('2026-03-30T09:00:00.000Z'),
        },
      }) as never,
    calculateBurnoutRisk: () =>
      ({
        algorithmVersion: 'burnout-risk-v1',
        riskScore: 79,
        severity: 'high',
        components: {
          saturnLoad: 22,
          moonLoad: 18,
          workloadMismatch: 19,
          tagPressure: 16,
          recoveryBuffer: 10,
        },
        signals: {
          saturnHardCount: 2.2,
          moonHardCount: 2.8,
          saturnMoonHard: 0.9,
          riskTagContextSwitch: 80,
          riskTagRushBias: 65,
          positiveAspectStrength: 14.1,
          momentum: {
            energy: 12.4,
            focus: -7.2,
          },
          saturn: {
            house: 10,
            retrograde: true,
          },
          moon: {
            house: 6,
          },
        },
      }) as never,
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/burnout-plan',
      headers: {
        authorization: 'Bearer test',
      },
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.risk.score, 79);
    assert.equal(payload.risk.severity, 'high');
    assert.equal(payload.timing.status, 'not_scheduled');
    assert.equal(payload.timing.nextPlannedAt, null);
    assert.equal(payload.timing.scheduledDateKey, null);
    assert.equal(payload.timing.scheduledSeverity, null);
  } finally {
    await app.close();
  }
});

test('burnout seen acknowledges current-day in-threshold card and cancels pending timing', async () => {
  const auth = buildFakeAuthContext('premium');
  let markSeenCalls = 0;
  const markSeenInputs: Array<Parameters<NotificationRouteDependencies['markBurnoutAlertJobSeenForUser']>[0]> = [];
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getOrCreateDailyTransitForUser: async () =>
      ({
        doc: {
          profileHash: 'profile-current',
          dateKey: '2026-03-30',
          generatedAt: new Date('2026-03-30T07:00:00.000Z'),
        },
      }) as never,
    calculateBurnoutRisk: () =>
      ({
        algorithmVersion: 'burnout-risk-v1',
        riskScore: 88,
        severity: 'critical',
        components: {
          saturnLoad: 30.2,
          moonLoad: 19.4,
          workloadMismatch: 8.2,
          tagPressure: 15.7,
          recoveryBuffer: 9.5,
        },
        signals: {
          saturnHardCount: 2.2,
          moonHardCount: 2.8,
          saturnMoonHard: 0.9,
          riskTagContextSwitch: 80,
          riskTagRushBias: 65,
          positiveAspectStrength: 14.1,
          momentum: {
            energy: 12.4,
            focus: -7.2,
          },
          saturn: {
            house: 10,
            retrograde: true,
          },
          moon: {
            house: 6,
          },
        },
      }) as never,
    resolveBurnoutPushSeverity: () => 'critical',
    markBurnoutAlertJobSeenForUser: async (input) => {
      markSeenCalls += 1;
      markSeenInputs.push(input);
      return {
        status: 'cancelled',
        job: null,
      };
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/notifications/burnout-seen',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        dateKey: '2026-03-30',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      acknowledged: true,
      reason: null,
      dateKey: '2026-03-30',
      timingStatus: 'cancelled',
    });
    assert.equal(markSeenCalls, 1);
    const markSeenInput = markSeenInputs[0];
    assert.ok(markSeenInput);
    assert.equal(markSeenInput.profileHash, 'profile-current');
    assert.deepEqual(markSeenInput.transitGeneratedAt, new Date('2026-03-30T07:00:00.000Z'));
  } finally {
    await app.close();
  }
});

test('burnout plan maps missing profile error to 404', async () => {
  const auth = buildFakeAuthContext('premium');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getBurnoutAlertSettingsForUser: async () => ({
      enabled: false,
      timezoneIana: 'Europe/Warsaw',
      workdayStartMinute: 540,
      workdayEndMinute: 1080,
      quietHoursStartMinute: 1290,
      quietHoursEndMinute: 480,
      updatedAt: null,
      source: 'default',
    }),
    getLatestBurnoutAlertJobForUser: async () => null,
    getOrCreateDailyTransitForUser: async () => {
      throw new Error('Birth profile not found. Complete onboarding first.');
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/burnout-plan',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(response.json(), {
      error: 'Birth profile not found. Complete onboarding first.',
    });
  } finally {
    await app.close();
  }
});

test('burnout and lunar alert endpoints do not wait for ai synergy generation', async () => {
  const auth = buildFakeAuthContext('premium');
  const transitOptions: unknown[] = [];
  const transitDoc = {
    profileHash: 'profile-current',
    dateKey: '2026-03-30',
    generatedAt: new Date('2026-03-30T07:00:00.000Z'),
  };
  const settings = {
    enabled: true,
    timezoneIana: 'Europe/Warsaw',
    workdayStartMinute: 540,
    workdayEndMinute: 1080,
    quietHoursStartMinute: 1290,
    quietHoursEndMinute: 480,
    updatedAt: new Date('2026-03-30T00:00:00.000Z').toISOString(),
    source: 'saved' as const,
  };
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getBurnoutAlertSettingsForUser: async () => settings,
    getLunarProductivitySettingsForUser: async () => settings,
    getLatestBurnoutAlertJobForUser: async () => null,
    getLatestLunarProductivityJobForUser: async () => null,
    getOrCreateDailyTransitForUser: async (_userId, _date, _logger, options) => {
      transitOptions.push(options);
      return {
        doc: transitDoc,
        cached: true,
        aiSynergy: null,
      } as never;
    },
    calculateBurnoutRisk: () =>
      ({
        algorithmVersion: 'burnout-risk-v1',
        riskScore: 88,
        severity: 'critical',
        components: {
          saturnLoad: 30.2,
          moonLoad: 19.4,
          workloadMismatch: 8.2,
          tagPressure: 15.7,
          recoveryBuffer: 9.5,
        },
        signals: {
          saturnHardCount: 2.2,
          moonHardCount: 2.8,
          saturnMoonHard: 0.9,
          riskTagContextSwitch: 80,
          riskTagRushBias: 65,
          positiveAspectStrength: 14.1,
          momentum: {
            energy: 12.4,
            focus: -7.2,
          },
          saturn: {
            house: 10,
            retrograde: true,
          },
          moon: {
            house: 6,
          },
        },
      }) as never,
    calculateLunarProductivityRisk: () => ({
      algorithmVersion: 'lunar-productivity-risk-v1',
      riskScore: 84,
      severity: 'high',
      components: {
        moonPhaseLoad: 15,
        emotionalTide: 8.5,
        focusResonance: 9.2,
        circadianAlignment: 21.1,
        recoveryBuffer: 12.4,
      },
      signals: {
        moonPhase: 'full_moon',
        illuminationPercent: 99.4,
        moonHouse: 6,
        hardAspectCount: 2.4,
        supportiveAspectStrength: 17.7,
        momentum: {
          energy: 9.8,
          focus: -4.2,
        },
      },
    }),
    resolveBurnoutPushSeverity: () => 'critical',
    resolveLunarProductivityImpactDirection: () => 'disruptive',
    resolveLunarProductivityPushSeverity: () => 'high',
    markBurnoutAlertJobSeenForUser: async () => ({
      status: 'cancelled',
      job: null,
    }),
    markLunarProductivityJobSeenForUser: async () => ({
      status: 'cancelled',
      job: null,
    }),
  });

  try {
    const cases: Array<{
      method: 'GET' | 'POST';
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: 'GET', url: '/api/notifications/burnout-plan' },
      { method: 'POST', url: '/api/notifications/burnout-seen', payload: { dateKey: '2026-03-30' } },
      { method: 'GET', url: '/api/notifications/lunar-productivity-plan' },
      { method: 'POST', url: '/api/notifications/lunar-productivity-seen', payload: { dateKey: '2026-03-30' } },
    ];

    for (const testCase of cases) {
      const response = await app.inject({
        method: testCase.method,
        url: testCase.url,
        headers: {
          authorization: 'Bearer test',
        },
        payload: testCase.payload,
      });
      assert.equal(response.statusCode, 200, `${testCase.method} ${testCase.url}`);
    }

    assert.deepEqual(transitOptions, [
      { includeAiSynergy: false },
      { includeAiSynergy: false },
      { includeAiSynergy: false },
      { includeAiSynergy: false },
    ]);
  } finally {
    await app.close();
  }
});

test('interview strategy settings save without triggering plan generation', async () => {
  const auth = buildFakeAuthContext('premium');
  let refillCalls = 0;
  const savedInputs: Array<Parameters<NotificationRouteDependencies['upsertInterviewStrategySettingsForUser']>[0]> = [];

  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    upsertInterviewStrategySettingsForUser: async (input) => {
      savedInputs.push(input);
      return {
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
        slotDurationMinutes: 60,
        allowedWeekdays: [1, 2, 3],
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
        slotsPerWeek: 3,
        autoFillConfirmedAt: new Date('2026-03-30T00:00:00.000Z'),
        autoFillStartAt: null,
        filledUntilDateKey: null,
        lastGeneratedAt: null,
        updatedAt: new Date('2026-03-30T00:00:00.000Z'),
        source: 'saved',
      } as never;
    },
    maybeRefillInterviewStrategyWindowForUser: async () => {
      refillCalls += 1;
      return {
        status: 'noop',
        reason: 'already_filled',
      } as never;
    },
  });

  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/notifications/interview-strategy-settings',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
        slotDurationMinutes: 60,
        allowedWeekdays: [1, 2, 3],
        workdayStartMinute: 540,
        workdayEndMinute: 1080,
        quietHoursStartMinute: 1290,
        quietHoursEndMinute: 480,
        slotsPerWeek: 3,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(refillCalls, 0);
    assert.equal(response.json().settings.enabled, true);
    assert.equal(savedInputs.length, 1);
    const savedInput = savedInputs[0];
    assert.ok(savedInput);
    assert.equal(savedInput.slotDurationMinutes, 60);
    assert.deepEqual(savedInput.allowedWeekdays, [1, 2, 3]);
  } finally {
    await app.close();
  }
});

test('interview strategy settings accept minimal payload for fixed-range planner', async () => {
  const auth = buildFakeAuthContext('premium');
  const savedInputs: Array<Parameters<NotificationRouteDependencies['upsertInterviewStrategySettingsForUser']>[0]> = [];
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    upsertInterviewStrategySettingsForUser: async (input) => {
      savedInputs.push(input);
      return {
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
        slotDurationMinutes: input.slotDurationMinutes,
        allowedWeekdays: input.allowedWeekdays,
        workdayStartMinute: input.workdayStartMinute,
        workdayEndMinute: input.workdayEndMinute,
        quietHoursStartMinute: input.quietHoursStartMinute,
        quietHoursEndMinute: input.quietHoursEndMinute,
        slotsPerWeek: input.slotsPerWeek,
        autoFillConfirmedAt: null,
        autoFillStartAt: null,
        filledUntilDateKey: null,
        lastGeneratedAt: null,
        updatedAt: null,
        source: 'saved',
      } as never;
    },
  });

  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/notifications/interview-strategy-settings',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        enabled: true,
        timezoneIana: 'Europe/Warsaw',
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(savedInputs.length, 1);
    const savedInput = savedInputs[0];
    assert.ok(savedInput);
    assert.equal(savedInput.slotDurationMinutes, 60);
    assert.deepEqual(savedInput.allowedWeekdays, [1, 2, 3, 4, 5]);
    assert.equal(savedInput.workdayStartMinute, 540);
    assert.equal(savedInput.workdayEndMinute, 1080);
    assert.equal(savedInput.slotsPerWeek, 5);
  } finally {
    await app.close();
  }
});

test('interview strategy plan refresh uses rebuild path; non-refresh uses refill path', async () => {
  const auth = buildFakeAuthContext('premium');
  let rebuildCalls = 0;
  let refillCalls = 0;
  let fetchCalls = 0;
  const rebuildInputs: unknown[] = [];
  const refillInputs: unknown[] = [];

  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    rebuildInterviewStrategyWindowForUser: async (input) => {
      rebuildCalls += 1;
      rebuildInputs.push(input);
      return {
        status: 'generated',
      } as never;
    },
    maybeRefillInterviewStrategyWindowForUser: async (input) => {
      refillCalls += 1;
      refillInputs.push(input);
      return {
        status: 'noop',
      } as never;
    },
    fetchInterviewStrategyPlanForUser: async () => {
      fetchCalls += 1;
      return {
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
      } as never;
    },
  });

  try {
    const refreshResponse = await app.inject({
      method: 'GET',
      url: '/api/notifications/interview-strategy-plan?refresh=true',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(refreshResponse.statusCode, 200);

    const nonRefreshResponse = await app.inject({
      method: 'GET',
      url: '/api/notifications/interview-strategy-plan?refresh=false',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(nonRefreshResponse.statusCode, 200);

    assert.equal(rebuildCalls, 1);
    assert.equal(refillCalls, 1);
    assert.equal(fetchCalls, 2);
    assert.equal((rebuildInputs[0] as { llmMode?: string }).llmMode, 'background');
    assert.equal((refillInputs[0] as { llmMode?: string }).llmMode, 'background');
  } finally {
    await app.close();
  }
});

test('interview strategy plan reports daily transit generation outages', async () => {
  const auth = buildFakeAuthContext('premium');
  const app = await buildNotificationsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    rebuildInterviewStrategyWindowForUser: async () => {
      throw new Error('Daily transit data unavailable for interview strategy generation');
    },
  });

  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/notifications/interview-strategy-plan?refresh=true',
      headers: {
        authorization: 'Bearer test',
      },
    });

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.json(), {
      error: 'Daily transit data unavailable for interview strategy generation.',
    });
  } finally {
    await app.close();
  }
});
