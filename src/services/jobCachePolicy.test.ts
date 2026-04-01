import assert from 'node:assert/strict';
import test from 'node:test';
import { env } from '../config/env.js';
import {
  buildParsedCacheExpiry,
  buildRawCacheExpiry,
  buildRawHtmlArtifactExpiry,
  isCacheValid,
} from './jobCachePolicy.js';

test('raw cache and parsed cache use JOB_CACHE_TTL_DAYS', () => {
  const now = new Date('2026-03-17T00:00:00.000Z');
  const expectedMs = env.JOB_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
  const rawExpiry = buildRawCacheExpiry(now);
  const parsedExpiry = buildParsedCacheExpiry(now);

  assert.equal(rawExpiry.getTime(), now.getTime() + expectedMs);
  assert.equal(parsedExpiry.getTime(), now.getTime() + expectedMs);
});

test('raw html artifact retention uses JOB_SCRAPER_RAW_HTML_RETENTION_DAYS independently', () => {
  const now = new Date('2026-03-17T00:00:00.000Z');
  const expectedMs = env.JOB_SCRAPER_RAW_HTML_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const artifactExpiry = buildRawHtmlArtifactExpiry(now);

  assert.equal(artifactExpiry.getTime(), now.getTime() + expectedMs);
});

test('isCacheValid respects null expiry and expiry boundary', () => {
  const now = new Date('2026-03-17T00:00:00.000Z');

  assert.equal(isCacheValid(null, now), true);
  assert.equal(isCacheValid(undefined, now), true);
  assert.equal(isCacheValid(new Date('2026-03-17T00:00:00.001Z'), now), true);
  assert.equal(isCacheValid(new Date('2026-03-17T00:00:00.000Z'), now), false);
});
