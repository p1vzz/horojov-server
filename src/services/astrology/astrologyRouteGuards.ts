import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthContext } from '../auth.js';
import type { AstrologyRouteDependencies } from './astrologyRouteTypes.js';

export async function requireAstrologyAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AstrologyRouteDependencies,
): Promise<AuthContext | null> {
  const auth = await deps.authenticateByAuthorizationHeader(
    request.headers.authorization,
  );
  if (!auth) {
    await reply.code(401).send({ error: "Unauthorized" });
    return null;
  }
  return auth;
}

export async function requirePremiumAstrologyAuth(
  request: FastifyRequest,
  reply: FastifyReply,
  deps: AstrologyRouteDependencies,
): Promise<AuthContext | null> {
  const auth = await requireAstrologyAuth(request, reply, deps);
  if (!auth) return null;

  if (auth.user.subscriptionTier !== "premium") {
    await reply
      .code(403)
      .send({ error: "Premium required", code: "premium_required" });
    return null;
  }

  return auth;
}
