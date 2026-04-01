import { env } from '../config/env.js';

export function buildRawCacheExpiry(now: Date) {
  return new Date(now.getTime() + env.JOB_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function buildRawHtmlArtifactExpiry(now: Date) {
  return new Date(now.getTime() + env.JOB_SCRAPER_RAW_HTML_RETENTION_DAYS * 24 * 60 * 60 * 1000);
}

export function buildParsedCacheExpiry(now: Date) {
  return new Date(now.getTime() + env.JOB_CACHE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

export function isCacheValid(expiresAt: Date | null | undefined, now: Date) {
  if (!expiresAt) return true;
  return expiresAt.getTime() > now.getTime();
}
