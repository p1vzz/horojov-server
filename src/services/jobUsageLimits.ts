import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { getCollections, type JobUsageLimitsDoc, type UserDoc } from '../db/mongo.js';

export type UsagePlan = 'free' | 'premium';

export type UsageLimitState = {
  plan: UsagePlan;
  period: 'rolling_7_days' | 'daily_utc';
  limit: number;
  used: number;
  remaining: number;
  nextAvailableAt: string | null;
  canProceed: boolean;
};

const FREE_LIMIT = 1;
const FREE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const PREMIUM_DAILY_LIMIT = 10;

function toUtcDateKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

function startOfNextUtcDay(date: Date) {
  const next = new Date(date);
  next.setUTCHours(24, 0, 0, 0);
  return next;
}

function resolvePlan(plan: UsagePlan | null | undefined): UsagePlan {
  return plan === 'premium' ? 'premium' : 'free';
}

function fromUser(user: UserDoc): UsagePlan {
  return resolvePlan(user.subscriptionTier);
}

function ensureNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function resolveUserUsagePlan(user: UserDoc): UsagePlan {
  return fromUser(user);
}

function computeFreeState(doc: JobUsageLimitsDoc | null, now: Date): UsageLimitState {
  const startedAt = doc?.freeWindowStartedAt ?? null;
  const count = ensureNumber(doc?.freeWindowSuccessCount);

  if (!startedAt) {
    return {
      plan: 'free',
      period: 'rolling_7_days',
      limit: FREE_LIMIT,
      used: 0,
      remaining: FREE_LIMIT,
      nextAvailableAt: null,
      canProceed: true,
    };
  }

  const expiresAt = new Date(startedAt.getTime() + FREE_WINDOW_MS);
  if (now >= expiresAt) {
    return {
      plan: 'free',
      period: 'rolling_7_days',
      limit: FREE_LIMIT,
      used: 0,
      remaining: FREE_LIMIT,
      nextAvailableAt: null,
      canProceed: true,
    };
  }

  const used = clampInt(count, 0, FREE_LIMIT);
  const remaining = Math.max(0, FREE_LIMIT - used);
  return {
    plan: 'free',
    period: 'rolling_7_days',
    limit: FREE_LIMIT,
    used,
    remaining,
    nextAvailableAt: remaining > 0 ? null : expiresAt.toISOString(),
    canProceed: remaining > 0,
  };
}

function computePremiumState(doc: JobUsageLimitsDoc | null, now: Date): UsageLimitState {
  const todayKey = toUtcDateKey(now);
  const usedRaw = doc?.premiumDateKey === todayKey ? ensureNumber(doc?.premiumDailyCount) : 0;
  const used = clampInt(usedRaw, 0, PREMIUM_DAILY_LIMIT);
  const remaining = Math.max(0, PREMIUM_DAILY_LIMIT - used);

  return {
    plan: 'premium',
    period: 'daily_utc',
    limit: PREMIUM_DAILY_LIMIT,
    used,
    remaining,
    nextAvailableAt: remaining > 0 ? null : startOfNextUtcDay(now).toISOString(),
    canProceed: remaining > 0,
  };
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function unlimitedState(plan: UsagePlan): UsageLimitState {
  return {
    plan,
    period: plan === 'premium' ? 'daily_utc' : 'rolling_7_days',
    limit: 1_000_000,
    used: 0,
    remaining: 1_000_000,
    nextAvailableAt: null,
    canProceed: true,
  };
}

async function getUsageDoc(userId: ObjectId) {
  const collections = await getCollections();
  return collections.jobUsageLimits.findOne({ userId });
}

export async function getCurrentUsageLimitState(input: { userId: ObjectId; plan: UsagePlan; now?: Date }) {
  const now = input.now ?? new Date();
  const plan = resolvePlan(input.plan);
  if (!env.JOB_USAGE_LIMITS_ENABLED) {
    return unlimitedState(plan);
  }

  const doc = await getUsageDoc(input.userId);
  return plan === 'premium' ? computePremiumState(doc, now) : computeFreeState(doc, now);
}

export async function incrementUsageAfterSuccessfulProviderCall(input: {
  userId: ObjectId;
  plan: UsagePlan;
  now?: Date;
}) {
  if (!env.JOB_USAGE_LIMITS_ENABLED) {
    return;
  }

  const now = input.now ?? new Date();
  const plan = resolvePlan(input.plan);
  const collections = await getCollections();
  const existing = await collections.jobUsageLimits.findOne({ userId: input.userId });

  if (plan === 'free') {
    const startedAt = existing?.freeWindowStartedAt ?? null;
    const expired = !startedAt || now.getTime() >= startedAt.getTime() + FREE_WINDOW_MS;

    if (expired) {
      await collections.jobUsageLimits.updateOne(
        { userId: input.userId },
        {
          $set: {
            plan,
            freeWindowStartedAt: now,
            freeWindowSuccessCount: 1,
            updatedAt: now,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            userId: input.userId,
            premiumDateKey: null,
            premiumDailyCount: 0,
            createdAt: now,
          },
        },
        { upsert: true }
      );
      return;
    }

    await collections.jobUsageLimits.updateOne(
      { userId: input.userId },
      {
        $set: { plan, updatedAt: now },
        $inc: { freeWindowSuccessCount: 1 },
      }
    );
    return;
  }

  const todayKey = toUtcDateKey(now);
  if (!existing || existing.premiumDateKey !== todayKey) {
    await collections.jobUsageLimits.updateOne(
      { userId: input.userId },
      {
        $set: {
          plan,
          premiumDateKey: todayKey,
          premiumDailyCount: 1,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          userId: input.userId,
          freeWindowStartedAt: null,
          freeWindowSuccessCount: 0,
          createdAt: now,
        },
      },
      { upsert: true }
    );
    return;
  }

  await collections.jobUsageLimits.updateOne(
    { userId: input.userId },
    {
      $set: { plan, updatedAt: now },
      $inc: { premiumDailyCount: 1 },
    }
  );
}
