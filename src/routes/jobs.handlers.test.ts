import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, {
  type FastifyInstance,
  type RouteHandlerMethod,
} from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../services/auth.js';
import type { JobMetricsReport } from '../services/jobMetrics.js';
import type { UsageLimitState } from '../services/jobUsageLimits.js';
import {
  registerJobRoutes,
  type JobsRouteDependencies,
} from './jobs.handlers.js';

const fakeLimit: UsageLimitState = {
  plan: "premium",
  period: "daily_utc",
  limit: 10,
  used: 2,
  remaining: 8,
  nextAvailableAt: null,
  canProceed: true,
};

const baseMetricsReport: JobMetricsReport = {
  window: {
    hours: 24,
    from: new Date("2026-03-24T00:00:00.000Z").toISOString(),
    to: new Date("2026-03-25T00:00:00.000Z").toISOString(),
  },
  totals: {
    rawFetches: 0,
    negativeEvents: 0,
    parsedDocs: 0,
  },
  sources: [],
};

function buildFakeAuthContext(): AuthContext {
  const userId = new ObjectId();
  const now = new Date();
  return {
    user: {
      _id: userId,
      kind: "anonymous",
      subscriptionTier: "free",
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

async function buildJobsTestApp(
  deps?: Partial<JobsRouteDependencies>,
): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerJobRoutes, {
    prefix: "/api/jobs",
    deps,
  });
  return app;
}

test("jobs routes return 401 for unauthenticated requests", async () => {
  const app = await buildJobsTestApp();
  try {
    const cases: Array<{
      method: "GET" | "POST";
      url: string;
      payload?: Record<string, unknown>;
    }> = [
      { method: "GET", url: "/api/jobs/limits" },
      { method: "GET", url: "/api/jobs/metrics" },
      { method: "GET", url: "/api/jobs/alerts" },
      {
        method: "POST",
        url: "/api/jobs/preflight",
        payload: { url: "https://www.linkedin.com/jobs/view/1234567890/" },
      },
      {
        method: "POST",
        url: "/api/jobs/analyze-screenshots",
        payload: {
          screenshots: [{ dataUrl: `data:image/png;base64,${"a".repeat(80)}` }],
        },
      },
      {
        method: "POST",
        url: "/api/jobs/analyze",
        payload: { url: "https://www.linkedin.com/jobs/view/1234567890/" },
      },
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

test("metrics and alerts reject invalid query before expensive work", async () => {
  let collectCalled = false;
  const auth = buildFakeAuthContext();
  const app = await buildJobsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    collectJobMetrics: async () => {
      collectCalled = true;
      return baseMetricsReport;
    },
  });

  try {
    const metricsResponse = await app.inject({
      method: "GET",
      url: "/api/jobs/metrics?windowHours=0",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(metricsResponse.statusCode, 400);
    assert.equal(metricsResponse.json().error, "Invalid metrics query");

    const alertsResponse = await app.inject({
      method: "GET",
      url: "/api/jobs/alerts?windowHours=10000",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(alertsResponse.statusCode, 400);
    assert.equal(alertsResponse.json().error, "Invalid alerts query");
    assert.equal(collectCalled, false);
  } finally {
    await app.close();
  }
});

test("jobs route wiring delegates to injected handlers", async () => {
  const auth = buildFakeAuthContext();
  let preflightCalls = 0;
  let screenshotsCalls = 0;
  let analyzeCalls = 0;
  let metricsHours: number | undefined;

  const preflightHandler: RouteHandlerMethod = async () => {
    preflightCalls += 1;
    return { ok: "preflight" };
  };
  const screenshotsHandler: RouteHandlerMethod = async () => {
    screenshotsCalls += 1;
    return { ok: "screenshots" };
  };
  const analyzeHandler: RouteHandlerMethod = async () => {
    analyzeCalls += 1;
    return { ok: "analyze" };
  };

  const app = await buildJobsTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    resolveUserUsagePlan: () => "premium",
    getCurrentUsageLimitState: async () => fakeLimit,
    collectJobMetrics: async (windowHoursInput) => {
      metricsHours = windowHoursInput;
      return {
        ...baseMetricsReport,
        window: {
          ...baseMetricsReport.window,
          hours: windowHoursInput ?? baseMetricsReport.window.hours,
        },
      };
    },
    evaluateJobMetricsAlerts: (metrics) => ({
      generatedAt: new Date("2026-03-25T00:00:00.000Z").toISOString(),
      window: metrics.window,
      thresholds: {
        minEvents: 10,
        blockedRatePct: 50,
        browserFallbackRatePct: 40,
        successRateMinPct: 20,
      },
      hasAlerts: false,
      alerts: [],
    }),
    handleJobPreflight: preflightHandler,
    handleJobAnalyzeScreenshots: screenshotsHandler,
    handleJobAnalyze: analyzeHandler,
  });

  try {
    const limitsResponse = await app.inject({
      method: "GET",
      url: "/api/jobs/limits",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(limitsResponse.statusCode, 200);
    assert.equal(limitsResponse.json().plan, "premium");
    assert.deepEqual(limitsResponse.json().limit, fakeLimit);

    const metricsResponse = await app.inject({
      method: "GET",
      url: "/api/jobs/metrics?windowHours=12",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(metricsResponse.statusCode, 200);
    assert.equal(metricsResponse.json().window.hours, 12);
    assert.equal(metricsHours, 12);

    const alertsResponse = await app.inject({
      method: "GET",
      url: "/api/jobs/alerts?windowHours=6",
      headers: { authorization: "Bearer test" },
    });
    assert.equal(alertsResponse.statusCode, 200);
    assert.equal(alertsResponse.json().hasAlerts, false);

    const preflightResponse = await app.inject({
      method: "POST",
      url: "/api/jobs/preflight",
      headers: { authorization: "Bearer test" },
      payload: { url: "https://example.com/jobs/1" },
    });
    assert.equal(preflightResponse.statusCode, 200);
    assert.equal(preflightResponse.json().ok, "preflight");

    const screenshotsResponse = await app.inject({
      method: "POST",
      url: "/api/jobs/analyze-screenshots",
      headers: { authorization: "Bearer test" },
      payload: {
        screenshots: [{ dataUrl: `data:image/png;base64,${"a".repeat(80)}` }],
      },
    });
    assert.equal(screenshotsResponse.statusCode, 200);
    assert.equal(screenshotsResponse.json().ok, "screenshots");

    const analyzeResponse = await app.inject({
      method: "POST",
      url: "/api/jobs/analyze",
      headers: { authorization: "Bearer test" },
      payload: { url: "https://example.com/jobs/1" },
    });
    assert.equal(analyzeResponse.statusCode, 200);
    assert.equal(analyzeResponse.json().ok, "analyze");

    assert.equal(preflightCalls, 1);
    assert.equal(screenshotsCalls, 1);
    assert.equal(analyzeCalls, 1);
  } finally {
    await app.close();
  }
});
