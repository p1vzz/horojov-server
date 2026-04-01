import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify, { type FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import type { AuthContext } from '../services/auth.js';
import { registerAuthRoutes, type AuthRouteDependencies } from './auth.js';

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

async function buildAuthTestApp(deps?: Partial<AuthRouteDependencies>): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(registerAuthRoutes, {
    prefix: '/api/auth',
    deps,
  });
  return app;
}

test('auth routes protect /me and /apple-link with 401', async () => {
  const app = await buildAuthTestApp({
    authenticateByAuthorizationHeader: async () => null,
  });

  try {
    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
    });
    assert.equal(meResponse.statusCode, 401);
    assert.deepEqual(meResponse.json(), { error: 'Unauthorized' });

    const appleLinkResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/apple-link',
      payload: {
        appleSub: 'apple-sub-12345',
      },
    });
    assert.equal(appleLinkResponse.statusCode, 401);
    assert.deepEqual(appleLinkResponse.json(), { error: 'Unauthorized' });
  } finally {
    await app.close();
  }
});

test('refresh rejects invalid payload before rotation call', async () => {
  let rotateCalls = 0;
  const app = await buildAuthTestApp({
    rotateSessionByRefreshToken: async () => {
      rotateCalls += 1;
      return null;
    },
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {
        refreshToken: 'short',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'Invalid refresh payload');
    assert.equal(rotateCalls, 0);
  } finally {
    await app.close();
  }
});

test('refresh returns 401 when token is invalid or expired', async () => {
  const app = await buildAuthTestApp({
    rotateSessionByRefreshToken: async () => null,
  });

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {
        refreshToken: 'x'.repeat(24),
      },
    });
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.json(), { error: 'Invalid or expired refresh token' });
  } finally {
    await app.close();
  }
});

test('logout rejects invalid payload', async () => {
  const app = await buildAuthTestApp();
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      payload: {
        refreshToken: 'tiny',
      },
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, 'Invalid logout payload');
  } finally {
    await app.close();
  }
});

test('auth route wiring delegates to injected dependencies', async () => {
  const authContext = buildFakeAuthContext('premium');
  const createdUser = authContext.user;
  const createdTokens = {
    accessToken: 'access-token',
    refreshToken: 'refresh-token',
    accessExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    refreshExpiresAt: new Date(Date.now() + 120_000).toISOString(),
  };
  let revokeByRefreshCalls = 0;
  let revokeByAccessCalls = 0;

  const app = await buildAuthTestApp({
    authenticateByAuthorizationHeader: async () => authContext,
    createAnonymousSession: async () => ({
      user: createdUser,
      tokens: createdTokens,
    }),
    rotateSessionByRefreshToken: async () => ({
      user: authContext.user,
      tokens: createdTokens,
    }),
    linkAppleIdentityToUser: async () => ({
      ok: true,
      user: authContext.user,
    }),
    revokeSessionByRefreshToken: async () => {
      revokeByRefreshCalls += 1;
    },
    revokeSessionByAccessHeader: async () => {
      revokeByAccessCalls += 1;
    },
  });

  try {
    const anonymousResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/anonymous',
    });
    assert.equal(anonymousResponse.statusCode, 201);
    assert.equal(anonymousResponse.json().session.accessToken, 'access-token');

    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      payload: {
        refreshToken: 'x'.repeat(24),
      },
    });
    assert.equal(refreshResponse.statusCode, 200);
    assert.equal(refreshResponse.json().session.refreshToken, 'refresh-token');

    const meResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: {
        authorization: 'Bearer test',
      },
    });
    assert.equal(meResponse.statusCode, 200);
    assert.equal(meResponse.json().user.id, authContext.user._id.toHexString());

    const appleLinkResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/apple-link',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        appleSub: 'apple-sub-12345',
      },
    });
    assert.equal(appleLinkResponse.statusCode, 200);
    assert.equal(appleLinkResponse.json().user.id, authContext.user._id.toHexString());

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: {
        authorization: 'Bearer test',
      },
      payload: {
        refreshToken: 'x'.repeat(24),
      },
    });
    assert.equal(logoutResponse.statusCode, 204);
    assert.equal(revokeByRefreshCalls, 1);
    assert.equal(revokeByAccessCalls, 1);
  } finally {
    await app.close();
  }
});
