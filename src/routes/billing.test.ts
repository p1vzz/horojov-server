import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../services/auth.js';
import { registerBillingRoutes, type BillingRouteDependencies } from './billing.js';

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

async function buildBillingTestApp(deps?: Partial<BillingRouteDependencies>): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerBillingRoutes, {
    prefix: '/api/billing',
    deps,
  });
  return app;
}

test('billing routes return 401 for unauthenticated user endpoints', async () => {
  const app = await buildBillingTestApp({
    authenticateByAuthorizationHeader: async () => null,
  });

  try {
    const subscriptionResponse = await app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
    });
    assert.equal(subscriptionResponse.statusCode, 401);
    assert.deepEqual(subscriptionResponse.json(), { error: 'Unauthorized' });

    const syncResponse = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/sync',
    });
    assert.equal(syncResponse.statusCode, 401);
    assert.deepEqual(syncResponse.json(), { error: 'Unauthorized' });
  } finally {
    await app.close();
  }
});

test('revenuecat webhook enforces configured auth token and bearer match', async () => {
  const appMissingConfig = await buildBillingTestApp({
    expectedWebhookAuthorization: () => null,
  });

  try {
    const missingConfigResponse = await appMissingConfig.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      payload: {},
    });
    assert.equal(missingConfigResponse.statusCode, 500);
    assert.equal(missingConfigResponse.json().error, 'RevenueCat webhook auth token is not configured');
  } finally {
    await appMissingConfig.close();
  }

  const appInvalidAuth = await buildBillingTestApp({
    expectedWebhookAuthorization: () => 'Bearer expected-token',
  });

  try {
    const invalidAuthResponse = await appInvalidAuth.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      headers: {
        authorization: 'Bearer wrong-token',
      },
      payload: {},
    });
    assert.equal(invalidAuthResponse.statusCode, 401);
    assert.equal(invalidAuthResponse.json().error, 'Unauthorized webhook request');
  } finally {
    await appInvalidAuth.close();
  }
});

test('revenuecat webhook validates payload before storage/sync', async () => {
  let getCollectionsCalls = 0;
  const app = await buildBillingTestApp({
    expectedWebhookAuthorization: () => 'Bearer expected-token',
    getCollections: async () => {
      getCollectionsCalls += 1;
      throw new Error('should not be called');
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      headers: {
        authorization: 'Bearer expected-token',
      },
      payload: {},
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'Invalid RevenueCat webhook payload');
    assert.equal(getCollectionsCalls, 0);
  } finally {
    await app.close();
  }
});

test('billing subscription and manual sync delegate to dependencies', async () => {
  const auth = buildFakeAuthContext('premium');
  const subscriptionSnapshot = {
    tier: 'premium',
    status: 'active',
    provider: 'revenuecat',
    source: 'sync',
  };

  const app = await buildBillingTestApp({
    authenticateByAuthorizationHeader: async () => auth,
    getBillingSnapshotForUser: async () => subscriptionSnapshot as never,
    syncRevenueCatForUser: async () => ({
      user: auth.user,
      subscription: subscriptionSnapshot as never,
    }),
  });

  try {
    const subscriptionResponse = await app.inject({
      method: 'GET',
      url: '/api/billing/subscription',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(subscriptionResponse.statusCode, 200);
    assert.equal(subscriptionResponse.json().user.id, auth.user._id.toHexString());
    assert.equal(subscriptionResponse.json().subscription.tier, 'premium');

    const syncResponse = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/sync',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(syncResponse.statusCode, 200);
    assert.equal(syncResponse.json().subscription.status, 'active');
  } finally {
    await app.close();
  }
});

test('revenuecat webhook returns duplicate response when event already processed', async () => {
  const app = await buildBillingTestApp({
    expectedWebhookAuthorization: () => 'Bearer expected-token',
    getCollections: async () =>
      ({
        revenueCatEvents: {
          findOne: async () => ({
            eventId: 'evt_1',
            processingStatus: 'processed',
          }),
          updateOne: async () => ({ matchedCount: 0 }),
          insertOne: async () => ({ acknowledged: true }),
        },
      }) as never,
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      headers: {
        authorization: 'Bearer expected-token',
      },
      payload: {
        event: {
          id: 'evt_1',
          type: 'INITIAL_PURCHASE',
        },
      },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, duplicate: true });
  } finally {
    await app.close();
  }
});

test('revenuecat webhook processes event and marks it processed', async () => {
  const updates: Array<{ filter: unknown; update: unknown }> = [];
  const authUserId = new ObjectId();

  const app = await buildBillingTestApp({
    expectedWebhookAuthorization: () => 'Bearer expected-token',
    getCollections: async () =>
      ({
        revenueCatEvents: {
          findOne: async () => null,
          updateOne: async (filter: unknown, update: unknown) => {
            updates.push({ filter, update });
            return { matchedCount: 1 };
          },
          insertOne: async () => ({ acknowledged: true }),
        },
      }) as never,
    syncRevenueCatForAppUserId: async () =>
      ({
        user: {
          _id: authUserId,
        },
      }) as never,
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      headers: {
        authorization: 'Bearer expected-token',
      },
      payload: {
        event: {
          id: 'evt_processed',
          type: 'INITIAL_PURCHASE',
          app_user_id: 'app_user_1',
          event_timestamp_ms: Date.parse('2026-03-30T10:00:00.000Z'),
        },
      },
    });

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), { ok: true, status: 'processed' });
    assert.ok(updates.length >= 1);
    const lastUpdate = updates[updates.length - 1];
    const lastSet = (lastUpdate?.update as { $set?: Record<string, unknown> })?.$set ?? {};
    assert.equal(lastSet.processingStatus, 'processed');
    assert.equal(lastSet.userId instanceof ObjectId, true);
  } finally {
    await app.close();
  }
});

test('revenuecat webhook handles sync failure and marks event failed', async () => {
  const updates: Array<{ filter: unknown; update: unknown }> = [];

  const app = await buildBillingTestApp({
    expectedWebhookAuthorization: () => 'Bearer expected-token',
    getCollections: async () =>
      ({
        revenueCatEvents: {
          findOne: async () => null,
          updateOne: async (filter: unknown, update: unknown) => {
            updates.push({ filter, update });
            return { matchedCount: 1 };
          },
          insertOne: async () => ({ acknowledged: true }),
        },
      }) as never,
    syncRevenueCatForAppUserId: async () => {
      throw new Error('sync crash');
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/billing/revenuecat/webhook',
      headers: {
        authorization: 'Bearer expected-token',
      },
      payload: {
        event: {
          id: 'evt_failed',
          type: 'INITIAL_PURCHASE',
          app_user_id: 'app_user_2',
        },
      },
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json(), { error: 'Webhook processing failed' });
    assert.ok(updates.length >= 1);
    const lastUpdate = updates[updates.length - 1];
    const lastSet = (lastUpdate?.update as { $set?: Record<string, unknown> })?.$set ?? {};
    assert.equal(lastSet.processingStatus, 'failed');
    assert.equal(lastSet.errorMessage, 'sync crash');
  } finally {
    await app.close();
  }
});
