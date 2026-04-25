import assert from 'node:assert/strict';
import test from 'node:test';
import { ObjectId } from 'mongodb';
import {
  computeJobUsageLimitSnapshot,
  resolveJobScanDepth,
  type JobUsageLimitSnapshot,
} from './jobUsageLimits.js';
import type { JobUsageLimitsDoc } from '../db/mongo.js';

function createDoc(overrides: Partial<JobUsageLimitsDoc> = {}): JobUsageLimitsDoc {
  const now = new Date('2026-04-22T10:00:00.000Z');
  return {
    _id: new ObjectId(),
    userId: new ObjectId(),
    plan: 'free',
    freeWindowStartedAt: null,
    freeWindowSuccessCount: 0,
    premiumDateKey: null,
    premiumDailyCount: 0,
    liteDateKey: null,
    liteDailyCount: 0,
    fullDateKey: null,
    fullDailyCount: 0,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function snapshotWithUsage(input: {
  plan?: 'free' | 'premium';
  liteUsed?: number;
  fullUsed?: number;
}): JobUsageLimitSnapshot {
  const now = new Date('2026-04-22T10:00:00.000Z');
  return computeJobUsageLimitSnapshot({
    now,
    plan: input.plan ?? 'free',
    doc: createDoc({
      plan: input.plan ?? 'free',
      liteDateKey: '2026-04-22',
      liteDailyCount: input.liteUsed ?? 0,
      fullDateKey: '2026-04-22',
      fullDailyCount: input.fullUsed ?? 0,
    }),
  });
}

test('job usage limits expose free lite and full daily quotas', () => {
  const snapshot = snapshotWithUsage({
    plan: 'free',
    liteUsed: 4,
    fullUsed: 1,
  });

  assert.equal(snapshot.lite.depth, 'lite');
  assert.equal(snapshot.lite.period, 'daily_utc');
  assert.equal(snapshot.lite.limit, 30);
  assert.equal(snapshot.lite.remaining, 26);
  assert.equal(snapshot.lite.canProceed, true);
  assert.equal(snapshot.full.depth, 'full');
  assert.equal(snapshot.full.limit, 1);
  assert.equal(snapshot.full.remaining, 0);
  assert.equal(snapshot.full.canProceed, false);
});

test('job usage limits expose premium full quota and shared lite quota', () => {
  const snapshot = snapshotWithUsage({
    plan: 'premium',
    liteUsed: 29,
    fullUsed: 9,
  });

  assert.equal(snapshot.lite.limit, 30);
  assert.equal(snapshot.lite.remaining, 1);
  assert.equal(snapshot.full.limit, 10);
  assert.equal(snapshot.full.remaining, 1);
});

test('auto scan depth falls back to lite when full quota is exhausted', () => {
  const snapshot = snapshotWithUsage({
    plan: 'free',
    liteUsed: 7,
    fullUsed: 1,
  });

  const resolution = resolveJobScanDepth({
    limits: snapshot,
    requestedDepth: 'auto',
  });

  assert.equal(resolution.canProceed, true);
  assert.equal(resolution.depth, 'lite');
  assert.equal(resolution.limit.depth, 'lite');
});

test('explicit full scan depth blocks when full quota is exhausted', () => {
  const snapshot = snapshotWithUsage({
    plan: 'free',
    liteUsed: 0,
    fullUsed: 1,
  });

  const resolution = resolveJobScanDepth({
    limits: snapshot,
    requestedDepth: 'full',
  });

  assert.equal(resolution.canProceed, false);
  assert.equal(resolution.depth, 'full');
  assert.equal(resolution.limit.nextAvailableAt, '2026-04-23T00:00:00.000Z');
});

test('legacy premium daily count is treated as full usage until new full fields exist', () => {
  const snapshot = computeJobUsageLimitSnapshot({
    now: new Date('2026-04-22T10:00:00.000Z'),
    plan: 'premium',
    doc: createDoc({
      plan: 'premium',
      premiumDateKey: '2026-04-22',
      premiumDailyCount: 3,
      fullDateKey: null,
      fullDailyCount: 0,
    }),
  });

  assert.equal(snapshot.full.used, 3);
  assert.equal(snapshot.full.remaining, 7);
});
