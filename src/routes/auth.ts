import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
};

export type RegisterAuthRoutesOptions = {
  deps?: Partial<AuthRouteDependencies>;
};

const defaultDeps: AuthRouteDependencies = {
  authenticateByAuthorizationHeader,
  createAnonymousSession,
  linkAppleIdentityToUser,
  revokeSessionByAccessHeader,
  revokeSessionByRefreshToken,
  rotateSessionByRefreshToken,
  toPublicUser,
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

  app.post('/anonymous', async (_request, reply) => {
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
