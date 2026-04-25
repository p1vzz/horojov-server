import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { getCollections, type JobUsageLimitsDoc, type UserDoc } from '../db/mongo.js';

export type UsagePlan = 'free' | 'premium';
export type JobScanDepth = 'lite' | 'full';
export type JobScanDepthRequest = 'auto' | JobScanDepth;

export type UsageLimitState = {
  plan: UsagePlan;
  depth: JobScanDepth;
  period: 'rolling_7_days' | 'daily_utc';
  limit: number;
  used: number;
  remaining: number;
  nextAvailableAt: string | null;
  canProceed: boolean;
};

export type JobUsageLimitSnapshot = {
  plan: UsagePlan;
  lite: UsageLimitState;
  full: UsageLimitState;
};

export type ResolvedJobScanDepth =
  | {
      canProceed: true;
      depth: JobScanDepth;
      limit: UsageLimitState;
      limits: JobUsageLimitSnapshot;
    }
  | {
      canProceed: false;
      depth: JobScanDepth;
      limit: UsageLimitState;
      limits: JobUsageLimitSnapshot;
    };

const LEGACY_FREE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
export const JOB_LITE_DAILY_LIMIT = 30;
export const JOB_FREE_FULL_DAILY_LIMIT = 1;
export const JOB_PREMIUM_FULL_DAILY_LIMIT = 10;

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

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

export function resolveUserUsagePlan(user: UserDoc): UsagePlan {
  return fromUser(user);
}

function buildDailyState(input: {
  plan: UsagePlan;
  depth: JobScanDepth;
  limit: number;
  dateKey: string | null | undefined;
  count: number | null | undefined;
  todayKey: string;
  now: Date;
}): UsageLimitState {
  const usedRaw = input.dateKey === input.todayKey ? ensureNumber(input.count) : 0;
  const used = clampInt(usedRaw, 0, input.limit);
  const remaining = Math.max(0, input.limit - used);

  return {
    plan: input.plan,
    depth: input.depth,
    period: 'daily_utc',
    limit: input.limit,
    used,
    remaining,
    nextAvailableAt: remaining > 0 ? null : startOfNextUtcDay(input.now).toISOString(),
    canProceed: remaining > 0,
  };
}

function legacyFullUsage(doc: JobUsageLimitsDoc | null, plan: UsagePlan, todayKey: string, now: Date) {
  if (!doc) return { dateKey: null, count: 0 };
  if (doc.fullDateKey) {
    return {
      dateKey: doc.fullDateKey,
      count: ensureNumber(doc.fullDailyCount),
    };
  }
  if (plan === 'premium' && doc.premiumDateKey === todayKey) {
    return {
      dateKey: doc.premiumDateKey,
      count: ensureNumber(doc.premiumDailyCount),
    };
  }
  if (plan === 'free' && doc.freeWindowStartedAt) {
    const legacyWindowActive = now.getTime() < doc.freeWindowStartedAt.getTime() + LEGACY_FREE_WINDOW_MS;
    return {
      dateKey:
        legacyWindowActive && ensureNumber(doc.freeWindowSuccessCount) > 0
          ? toUtcDateKey(doc.freeWindowStartedAt)
          : null,
      count: legacyWindowActive ? ensureNumber(doc.freeWindowSuccessCount) : 0,
    };
  }
  return { dateKey: null, count: 0 };
}

export function computeJobUsageLimitSnapshot(input: {
  doc: JobUsageLimitsDoc | null;
  plan: UsagePlan;
  now: Date;
}): JobUsageLimitSnapshot {
  const plan = resolvePlan(input.plan);
  const todayKey = toUtcDateKey(input.now);
  const fullLegacy = legacyFullUsage(input.doc, plan, todayKey, input.now);

  return {
    plan,
    lite: buildDailyState({
      plan,
      depth: 'lite',
      limit: JOB_LITE_DAILY_LIMIT,
      dateKey: input.doc?.liteDateKey,
      count: input.doc?.liteDailyCount,
      todayKey,
      now: input.now,
    }),
    full: buildDailyState({
      plan,
      depth: 'full',
      limit: plan === 'premium' ? JOB_PREMIUM_FULL_DAILY_LIMIT : JOB_FREE_FULL_DAILY_LIMIT,
      dateKey: fullLegacy.dateKey,
      count: fullLegacy.count,
      todayKey,
      now: input.now,
    }),
  };
}

function unlimitedState(plan: UsagePlan, depth: JobScanDepth): UsageLimitState {
  return {
    plan,
    depth,
    period: 'daily_utc',
    limit: 1_000_000,
    used: 0,
    remaining: 1_000_000,
    nextAvailableAt: null,
    canProceed: true,
  };
}

function unlimitedSnapshot(plan: UsagePlan): JobUsageLimitSnapshot {
  return {
    plan,
    lite: unlimitedState(plan, 'lite'),
    full: unlimitedState(plan, 'full'),
  };
}

async function getUsageDoc(userId: ObjectId) {
  const collections = await getCollections();
  return collections.jobUsageLimits.findOne({ userId });
}

export async function getCurrentJobUsageLimitSnapshot(input: {
  userId: ObjectId;
  plan: UsagePlan;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const plan = resolvePlan(input.plan);
  if (!env.JOB_USAGE_LIMITS_ENABLED) {
    return unlimitedSnapshot(plan);
  }

  const doc = await getUsageDoc(input.userId);
  return computeJobUsageLimitSnapshot({ doc, plan, now });
}

export async function getCurrentUsageLimitState(input: { userId: ObjectId; plan: UsagePlan; now?: Date }) {
  const snapshot = await getCurrentJobUsageLimitSnapshot(input);
  return snapshot.full;
}

export function resolveJobScanDepth(input: {
  limits: JobUsageLimitSnapshot;
  requestedDepth?: JobScanDepthRequest;
}): ResolvedJobScanDepth {
  const requestedDepth = input.requestedDepth ?? 'auto';
  if (requestedDepth === 'lite') {
    return {
      canProceed: input.limits.lite.canProceed,
      depth: 'lite',
      limit: input.limits.lite,
      limits: input.limits,
    };
  }

  if (requestedDepth === 'full') {
    return {
      canProceed: input.limits.full.canProceed,
      depth: 'full',
      limit: input.limits.full,
      limits: input.limits,
    };
  }

  if (input.limits.full.canProceed) {
    return {
      canProceed: true,
      depth: 'full',
      limit: input.limits.full,
      limits: input.limits,
    };
  }

  return {
    canProceed: input.limits.lite.canProceed,
    depth: 'lite',
    limit: input.limits.lite,
    limits: input.limits,
  };
}

export async function incrementUsageAfterSuccessfulScan(input: {
  userId: ObjectId;
  plan: UsagePlan;
  depth: JobScanDepth;
  now?: Date;
}) {
  if (!env.JOB_USAGE_LIMITS_ENABLED) {
    return;
  }

  const now = input.now ?? new Date();
  const plan = resolvePlan(input.plan);
  const todayKey = toUtcDateKey(now);
  const collections = await getCollections();
  const existing = await collections.jobUsageLimits.findOne({ userId: input.userId });

  if (input.depth === 'lite') {
    const resetCounter = !existing || existing.liteDateKey !== todayKey;
    await collections.jobUsageLimits.updateOne(
      { userId: input.userId },
      {
        $set: {
          plan,
          liteDateKey: todayKey,
          liteDailyCount: resetCounter ? 1 : ensureNumber(existing.liteDailyCount) + 1,
          updatedAt: now,
        },
        $setOnInsert: buildUsageSetOnInsert(input.userId, now),
      },
      { upsert: true },
    );
    return;
  }

  const resetCounter = !existing || existing.fullDateKey !== todayKey;
  await collections.jobUsageLimits.updateOne(
    { userId: input.userId },
    {
      $set: {
        plan,
        fullDateKey: todayKey,
        fullDailyCount: resetCounter ? 1 : ensureNumber(existing.fullDailyCount) + 1,
        premiumDateKey: todayKey,
        premiumDailyCount: resetCounter ? 1 : ensureNumber(existing.premiumDailyCount) + 1,
        freeWindowStartedAt: plan === 'free' ? now : (existing?.freeWindowStartedAt ?? null),
        freeWindowSuccessCount:
          plan === 'free'
            ? resetCounter
              ? 1
              : ensureNumber(existing?.freeWindowSuccessCount) + 1
            : ensureNumber(existing?.freeWindowSuccessCount),
        updatedAt: now,
      },
      $setOnInsert: buildUsageSetOnInsert(input.userId, now),
    },
    { upsert: true },
  );
}

export async function incrementUsageAfterSuccessfulProviderCall(input: {
  userId: ObjectId;
  plan: UsagePlan;
  now?: Date;
}) {
  await incrementUsageAfterSuccessfulScan({
    ...input,
    depth: 'full',
  });
}

function buildUsageSetOnInsert(userId: ObjectId, now: Date) {
  return {
    _id: new ObjectId(),
    userId,
    freeWindowStartedAt: null,
    freeWindowSuccessCount: 0,
    premiumDateKey: null,
    premiumDailyCount: 0,
    liteDateKey: null,
    liteDailyCount: 0,
    fullDateKey: null,
    fullDailyCount: 0,
    createdAt: now,
  };
}
