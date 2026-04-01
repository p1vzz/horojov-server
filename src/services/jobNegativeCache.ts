import { env } from '../config/env.js';
import type { JobProviderAttempt } from './jobProviders.js';

export type NegativeCacheStatus = 'blocked' | 'login_wall' | 'not_found';

export const NEGATIVE_CACHE_ERROR_TEXTS: Record<NegativeCacheStatus, string> = {
  login_wall: 'This job page requires sign-in, so data is unavailable in the current mode.',
  blocked: 'The source temporarily restricted access to this page. Please try again later.',
  not_found: 'The job posting was not found on the source page.',
};

function responseClassFromAttemptMeta(meta: unknown) {
  if (!meta || typeof meta !== 'object') return null;
  const value = (meta as Record<string, unknown>).responseClass;
  return typeof value === 'string' ? value : null;
}

export function classifyNegativeCacheStatus(attempts: JobProviderAttempt[]): NegativeCacheStatus | null {
  let sawLoginWall = false;
  let sawBlocked = false;

  for (const attempt of attempts) {
    if (attempt.ok) continue;

    const responseClass = responseClassFromAttemptMeta(attempt.meta);
    if (attempt.statusCode === 404 || responseClass === 'not_found') {
      return 'not_found';
    }

    if (responseClass === 'login_wall') {
      sawLoginWall = true;
    }

    if (
      attempt.statusCode === 401 ||
      attempt.statusCode === 403 ||
      attempt.statusCode === 429 ||
      responseClass === 'hard_block' ||
      responseClass === 'soft_block' ||
      responseClass === 'captcha' ||
      responseClass === 'empty'
    ) {
      sawBlocked = true;
    }
  }

  if (sawLoginWall) return 'login_wall';
  if (sawBlocked) return 'blocked';
  return null;
}

export function getNegativeCacheHttpStatus(status: NegativeCacheStatus) {
  switch (status) {
    case 'not_found':
      return 404;
    case 'login_wall':
      return 422;
    case 'blocked':
      return 429;
  }
}

export function getNegativeCacheTtlSeconds(status: NegativeCacheStatus) {
  switch (status) {
    case 'blocked':
      return env.JOB_SCRAPER_NEGATIVE_TTL_BLOCKED_SECONDS;
    case 'login_wall':
      return env.JOB_SCRAPER_NEGATIVE_TTL_LOGIN_WALL_SECONDS;
    case 'not_found':
      return env.JOB_SCRAPER_NEGATIVE_TTL_NOT_FOUND_SECONDS;
  }
}

export function buildNegativeCacheExpiry(status: NegativeCacheStatus, now: Date) {
  return new Date(now.getTime() + getNegativeCacheTtlSeconds(status) * 1000);
}

export function isNegativeCacheActive(expiresAt: Date | null | undefined, now: Date) {
  if (!expiresAt) return false;
  return expiresAt.getTime() > now.getTime();
}
