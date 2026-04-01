import { createHash, randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { getCollections, type SessionDoc, type UserDoc } from '../db/mongo.js';

export type PublicUser = {
  id: string;
  kind: UserDoc['kind'];
  subscriptionTier: 'free' | 'premium';
  appleLinked: boolean;
  email: string | null;
  displayName: string | null;
  createdAt: string;
};

export type SessionTokens = {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: string;
  refreshExpiresAt: string;
};

export type AuthContext = {
  user: UserDoc;
  session: SessionDoc;
};

const LAST_SEEN_TOUCH_INTERVAL_MS = 5 * 60 * 1000;

function tokenHash(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function generateToken(bytes: number) {
  return randomBytes(bytes).toString('hex');
}

function buildExpiry(seconds: number) {
  return new Date(Date.now() + seconds * 1000);
}

function normalizeBearerToken(authorization?: string) {
  if (!authorization) return null;
  const [scheme, token] = authorization.trim().split(/\s+/);
  if (!scheme || !token || scheme.toLowerCase() !== 'bearer') return null;
  return token;
}

function resolveEffectiveSubscriptionTier(input: UserDoc['subscriptionTier']) {
  if (env.DEV_FORCE_PREMIUM_FOR_ALL_USERS) return 'premium' as const;
  return input === 'premium' ? 'premium' : 'free';
}

function withEffectiveSubscriptionTier(user: UserDoc): UserDoc {
  const effectiveTier = resolveEffectiveSubscriptionTier(user.subscriptionTier);
  if (user.subscriptionTier === effectiveTier) return user;
  return {
    ...user,
    subscriptionTier: effectiveTier,
  };
}

export function toPublicUser(user: UserDoc): PublicUser {
  return {
    id: user._id.toHexString(),
    kind: user.kind,
    subscriptionTier: resolveEffectiveSubscriptionTier(user.subscriptionTier),
    appleLinked: Boolean(user.appleSub),
    email: user.email ?? null,
    displayName: user.displayName ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

export async function createAnonymousSession() {
  const collections = await getCollections();
  const now = new Date();

  const user: UserDoc = {
    _id: new ObjectId(),
    kind: 'anonymous',
    subscriptionTier: resolveEffectiveSubscriptionTier('free'),
    email: null,
    displayName: null,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  };
  await collections.users.insertOne(user);

  const tokens = await createSessionForUser(user._id);
  return { user, tokens };
}

export async function createSessionForUser(userId: ObjectId): Promise<SessionTokens> {
  const collections = await getCollections();
  const now = new Date();
  const accessToken = generateToken(32);
  const refreshToken = generateToken(48);
  const accessExpiresAt = buildExpiry(env.ACCESS_TOKEN_TTL_SECONDS);
  const refreshExpiresAt = buildExpiry(env.REFRESH_TOKEN_TTL_SECONDS);

  const session: SessionDoc = {
    _id: new ObjectId(),
    userId,
    accessTokenHash: tokenHash(accessToken),
    refreshTokenHash: tokenHash(refreshToken),
    accessExpiresAt,
    refreshExpiresAt,
    createdAt: now,
    updatedAt: now,
    revokedAt: null,
  };

  await collections.sessions.insertOne(session);

  return {
    accessToken,
    refreshToken,
    accessExpiresAt: accessExpiresAt.toISOString(),
    refreshExpiresAt: refreshExpiresAt.toISOString(),
  };
}

export async function authenticateByAuthorizationHeader(authorization?: string): Promise<AuthContext | null> {
  const accessToken = normalizeBearerToken(authorization);
  if (!accessToken) return null;

  const collections = await getCollections();
  const now = new Date();
  const session = await collections.sessions.findOne({
    accessTokenHash: tokenHash(accessToken),
    revokedAt: null,
    accessExpiresAt: { $gt: now },
  });
  if (!session) return null;

  const user = await collections.users.findOne({ _id: session.userId });
  if (!user) return null;
  const effectiveUser = withEffectiveSubscriptionTier(user);

  if (now.getTime() - user.lastSeenAt.getTime() >= LAST_SEEN_TOUCH_INTERVAL_MS) {
    await collections.users.updateOne(
      { _id: user._id },
      { $set: { lastSeenAt: now } }
    );
  }

  return { user: effectiveUser, session };
}

export async function rotateSessionByRefreshToken(refreshToken: string) {
  const collections = await getCollections();
  const now = new Date();
  const existingSession = await collections.sessions.findOne({
    refreshTokenHash: tokenHash(refreshToken),
    revokedAt: null,
    refreshExpiresAt: { $gt: now },
  });

  if (!existingSession) return null;

  const user = await collections.users.findOne({ _id: existingSession.userId });
  if (!user) return null;
  const effectiveUser = withEffectiveSubscriptionTier(user);

  const nextAccessToken = generateToken(32);
  const nextRefreshToken = generateToken(48);
  const nextAccessExpiresAt = buildExpiry(env.ACCESS_TOKEN_TTL_SECONDS);
  const nextRefreshExpiresAt = buildExpiry(env.REFRESH_TOKEN_TTL_SECONDS);

  await collections.sessions.updateOne(
    { _id: existingSession._id },
    {
      $set: {
        accessTokenHash: tokenHash(nextAccessToken),
        refreshTokenHash: tokenHash(nextRefreshToken),
        accessExpiresAt: nextAccessExpiresAt,
        refreshExpiresAt: nextRefreshExpiresAt,
        updatedAt: now,
      },
    }
  );

  await collections.users.updateOne(
    { _id: effectiveUser._id },
    { $set: { lastSeenAt: now, updatedAt: now } }
  );

  return {
    user: effectiveUser,
    tokens: {
      accessToken: nextAccessToken,
      refreshToken: nextRefreshToken,
      accessExpiresAt: nextAccessExpiresAt.toISOString(),
      refreshExpiresAt: nextRefreshExpiresAt.toISOString(),
    } satisfies SessionTokens,
  };
}

export async function revokeSessionByRefreshToken(refreshToken: string) {
  const collections = await getCollections();
  const now = new Date();
  await collections.sessions.updateOne(
    { refreshTokenHash: tokenHash(refreshToken), revokedAt: null },
    { $set: { revokedAt: now, updatedAt: now } }
  );
}

export async function revokeSessionByAccessHeader(authorization?: string) {
  const accessToken = normalizeBearerToken(authorization);
  if (!accessToken) return;
  const collections = await getCollections();
  const now = new Date();
  await collections.sessions.updateOne(
    { accessTokenHash: tokenHash(accessToken), revokedAt: null },
    { $set: { revokedAt: now, updatedAt: now } }
  );
}

export async function linkAppleIdentityToUser(userId: ObjectId, input: { appleSub: string; email?: string; displayName?: string }) {
  const collections = await getCollections();
  const now = new Date();

  const existingLinked = await collections.users.findOne({
    appleSub: input.appleSub,
    _id: { $ne: userId },
  });

  if (existingLinked) {
    return { ok: false as const, reason: 'apple_sub_in_use' as const };
  }

  await collections.users.updateOne(
    { _id: userId },
    {
      $set: {
        kind: 'registered',
        appleSub: input.appleSub,
        email: input.email ?? null,
        displayName: input.displayName ?? null,
        updatedAt: now,
        lastSeenAt: now,
      },
    }
  );

  const updated = await collections.users.findOne({ _id: userId });
  if (!updated) return { ok: false as const, reason: 'user_not_found' as const };
  return { ok: true as const, user: updated };
}
