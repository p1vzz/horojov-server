import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../config/env.js';
import {
  buildNegativeCacheExpiry,
  classifyNegativeCacheStatus,
  getNegativeCacheHttpStatus,
  getNegativeCacheTtlSeconds,
  isNegativeCacheActive,
} from './jobNegativeCache.js';
import type { JobProviderAttempt } from './jobProviders.js';

function failedAttempt(input: {
  statusCode: number | null;
  responseClass?: string;
  reason?: string;
}): JobProviderAttempt {
  return {
    provider: 'http_fetch',
    ok: false,
    statusCode: input.statusCode,
    reason: input.reason ?? 'failed',
    durationMs: 10,
    meta: input.responseClass ? { responseClass: input.responseClass } : undefined,
  };
}

test('classifyNegativeCacheStatus resolves not_found first when any attempt is 404/not_found', () => {
  const status = classifyNegativeCacheStatus([
    failedAttempt({ statusCode: 403, responseClass: 'hard_block' }),
    failedAttempt({ statusCode: 422, responseClass: 'login_wall' }),
    failedAttempt({ statusCode: 404, responseClass: 'not_found' }),
  ]);
  assert.equal(status, 'not_found');
});

test('classifyNegativeCacheStatus resolves login_wall when no not_found and login wall detected', () => {
  const status = classifyNegativeCacheStatus([
    failedAttempt({ statusCode: 422, responseClass: 'login_wall' }),
    failedAttempt({ statusCode: 422, responseClass: 'ok_partial' }),
  ]);
  assert.equal(status, 'login_wall');
});

test('classifyNegativeCacheStatus resolves blocked for hard block classes/statuses', () => {
  const status = classifyNegativeCacheStatus([
    failedAttempt({ statusCode: 429, responseClass: 'captcha' }),
  ]);
  assert.equal(status, 'blocked');
});

test('negative cache lifecycle uses status-specific TTL and expires correctly', () => {
  const now = new Date('2026-03-17T00:00:00.000Z');
  const status = 'blocked';
  const expiresAt = buildNegativeCacheExpiry(status, now);
  const ttlMs = getNegativeCacheTtlSeconds(status) * 1000;

  assert.equal(expiresAt.getTime(), now.getTime() + ttlMs);
  assert.equal(ttlMs, env.JOB_SCRAPER_NEGATIVE_TTL_BLOCKED_SECONDS * 1000);
  assert.equal(isNegativeCacheActive(expiresAt, new Date(now.getTime() + ttlMs - 1)), true);
  assert.equal(isNegativeCacheActive(expiresAt, new Date(now.getTime() + ttlMs)), false);
});

test('negative cache status maps to stable HTTP status codes', () => {
  assert.equal(getNegativeCacheHttpStatus('blocked'), 429);
  assert.equal(getNegativeCacheHttpStatus('login_wall'), 422);
  assert.equal(getNegativeCacheHttpStatus('not_found'), 404);
});
