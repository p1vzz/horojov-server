import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  authenticateByAuthorizationHeader,
  createAnonymousSession,
  linkAppleIdentityToUser,
  revokeSessionByAccessHeader,
  revokeSessionByRefreshToken,
  rotateSessionByRefreshToken,
  toPublicUser,
} from '../services/auth.js';

export type AuthRouteDependencies = {
  authenticateByAuthorizationHeader: typeof authenticateByAuthorizationHeader;
  createAnonymousSession: typeof createAnonymousSession;
  linkAppleIdentityToUser: typeof linkAppleIdentityToUser;
  revokeSessionByAccessHeader: typeof revokeSessionByAccessHeader;
  revokeSessionByRefreshToken: typeof revokeSessionByRefreshToken;
  rotateSessionByRefreshToken: typeof rotateSessionByRefreshToken;
  toPublicUser: typeof toPublicUser;
  checkAnonymousSessionRateLimit: AnonymousSessionRateLimiter;
};

export type RegisterAuthRoutesOptions = {
  deps?: Partial<AuthRouteDependencies>;
};

export type AnonymousSessionRateLimitResult =
  | { allowed: true }
  | { allowed: false; retryAfterSeconds: number };

export type AnonymousSessionRateLimiter = (input: {
  key: string;
  now: Date;
}) => AnonymousSessionRateLimitResult;

export function createInMemoryAnonymousSessionRateLimiter(options: {
  enabled: boolean;
  max: number;
  windowMs: number;
}): AnonymousSessionRateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const max = Math.max(1, Math.trunc(options.max));
  const windowMs = Math.max(1000, Math.trunc(options.windowMs));

  return ({ key, now }) => {
    if (!options.enabled) {
      return { allowed: true };
    }

    const nowMs = now.getTime();
    const bucketKey = key.trim().length > 0 ? key.trim() : 'unknown';
    const current = buckets.get(bucketKey);
    if (!current || current.resetAt <= nowMs) {
      buckets.set(bucketKey, {
        count: 1,
        resetAt: nowMs + windowMs,
      });
      return { allowed: true };
    }

    if (current.count >= max) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - nowMs) / 1000)),
      };
    }

    current.count += 1;
    return { allowed: true };
  };
}

function resolveAnonymousSessionRateLimitKey(request: { ip: string }) {
  return `ip:${request.ip}`;
}

const defaultDeps: AuthRouteDependencies = {
  authenticateByAuthorizationHeader,
  createAnonymousSession,
  linkAppleIdentityToUser,
  revokeSessionByAccessHeader,
  revokeSessionByRefreshToken,
  rotateSessionByRefreshToken,
  toPublicUser,
  checkAnonymousSessionRateLimit: createInMemoryAnonymousSessionRateLimiter({
    enabled: env.AUTH_ANONYMOUS_RATE_LIMIT_ENABLED,
    max: env.AUTH_ANONYMOUS_RATE_LIMIT_MAX,
    windowMs: env.AUTH_ANONYMOUS_RATE_LIMIT_WINDOW_MS,
  }),
};

const refreshSchema = z.object({
  refreshToken: z.string().min(16),
});

const logoutSchema = z.object({
  refreshToken: z.string().min(16).optional(),
});

const appleLinkSchema = z.object({
  appleSub: z.string().trim().min(8),
  email: z.string().trim().email().optional(),
  displayName: z.string().trim().min(1).max(80).optional(),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  options: RegisterAuthRoutesOptions = {},
): Promise<void> {
  const deps: AuthRouteDependencies = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };

  app.post('/anonymous', async (request, reply) => {
    const rateLimit = deps.checkAnonymousSessionRateLimit({
      key: resolveAnonymousSessionRateLimitKey(request),
      now: new Date(),
    });
    if (!rateLimit.allowed) {
      return reply
        .header('Retry-After', String(rateLimit.retryAfterSeconds))
        .code(429)
        .send({
          error: 'Too many anonymous session requests',
          code: 'anonymous_session_rate_limited',
          retryAfterSeconds: rateLimit.retryAfterSeconds,
        });
    }

    const { user, tokens } = await deps.createAnonymousSession();
    return reply.code(201).send({
      user: deps.toPublicUser(user),
      session: tokens,
    });
  });

  app.post('/refresh', async (request, reply) => {
    const parse = refreshSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({
        error: 'Invalid refresh payload',
        details: parse.error.flatten().fieldErrors,
      });
    }

    const rotated = await deps.rotateSessionByRefreshToken(parse.data.refreshToken);
    if (!rotated) {
      return reply.code(401).send({ error: 'Invalid or expired refresh token' });
    }

    return {
      user: deps.toPublicUser(rotated.user),
      session: rotated.tokens,
    };
  });

  app.get('/me', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }
    return { user: deps.toPublicUser(auth.user) };
  });

  app.post('/apple-link', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parse = appleLinkSchema.safeParse(request.body);
    if (!parse.success) {
      return reply.code(400).send({
        error: 'Invalid Apple identity payload',
        details: parse.error.flatten().fieldErrors,
      });
    }

    const linked = await deps.linkAppleIdentityToUser(auth.user._id, parse.data);
    if (!linked.ok && linked.reason === 'apple_sub_in_use') {
      return reply.code(409).send({ error: 'Apple account is already linked to another user' });
    }
    if (!linked.ok) {
      return reply.code(404).send({ error: 'User not found' });
    }

    return { user: deps.toPublicUser(linked.user) };
  });

  app.post('/logout', async (request, reply) => {
    const parse = logoutSchema.safeParse(request.body ?? {});
    if (!parse.success) {
      return reply.code(400).send({
        error: 'Invalid logout payload',
        details: parse.error.flatten().fieldErrors,
      });
    }

    if (parse.data.refreshToken) {
      await deps.revokeSessionByRefreshToken(parse.data.refreshToken);
    }
    await deps.revokeSessionByAccessHeader(request.headers.authorization);

    return reply.code(204).send();
  });
}
