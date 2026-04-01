import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { fetchRenderedHtml } from './browserFallback.js';
import type { CanonicalJobUrl, JobProviderName } from './jobUrl.js';

const MIN_DESCRIPTION_LENGTH = 180;
const MAX_DESCRIPTION_LENGTH = 16_000;
const MAX_NORMALIZED_TEXT_LENGTH = 18_000;

type PageAccess = 'public_ok' | 'soft_wall' | 'hard_wall' | 'blocked' | 'not_found';
type ResponseClass = 'ok_full' | 'ok_partial' | 'soft_block' | 'hard_block' | 'captcha' | 'login_wall' | 'empty' | 'not_found';

export type NormalizedJobPayload = {
  source: CanonicalJobUrl['source'];
  sourceJobId: string | null;
  canonicalUrl: string;
  title: string;
  company: string | null;
  location: string | null;
  description: string;
  employmentType: string | null;
  datePosted: string | null;
  seniority: string | null;
};

export type JobProviderAttempt = {
  provider: JobProviderName;
  ok: boolean;
  statusCode: number | null;
  reason: string;
  durationMs: number;
  meta?: Record<string, unknown>;
};

export type JobProviderSuccess = {
  ok: true;
  providerUsed: JobProviderName;
  attempts: JobProviderAttempt[];
  normalized: NormalizedJobPayload;
  normalizedText: string;
  jobContentHash: string;
  rawPayload: unknown;
  providerRequestId: string | null;
  providerMeta: Record<string, unknown>;
};

export type JobProviderFailure = {
  ok: false;
  attempts: JobProviderAttempt[];
  code: 'provider_failed';
  message: string;
};

type ProviderInternalSuccess = {
  provider: JobProviderName;
  normalized: NormalizedJobPayload;
  normalizedText: string;
  rawPayload: unknown;
  providerRequestId: string | null;
  providerMeta: Record<string, unknown>;
};

type ProviderInternalResult =
  | {
      ok: true;
      value: ProviderInternalSuccess;
    }
  | {
      ok: false;
      statusCode: number | null;
      reason: string;
      meta?: Record<string, unknown>;
    };

function stripHtml(input: string) {
  return input
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ');
}

function decodeEntities(input: string) {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&nbsp;': ' ',
  };

  return input
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (entity) => entities[entity] ?? entity)
    .replace(/&#(\d+);/g, (_match, num) => {
      const code = Number(num);
      return Number.isFinite(code) ? String.fromCharCode(code) : '';
    });
}

function normalizeWhitespace(input: string) {
  return input.replace(/\s+/g, ' ').trim();
}

function htmlToText(input: string) {
  return normalizeWhitespace(decodeEntities(stripHtml(input)));
}

function truncate(input: string, maxLength: number) {
  if (input.length <= maxLength) return input;
  return `${input.slice(0, maxLength - 3)}...`;
}

function coerceString(value: unknown) {
  if (typeof value !== 'string') return null;
  const normalized = normalizeWhitespace(value);
  return normalized.length > 0 ? normalized : null;
}

function normalizeDateString(value: unknown) {
  const text = coerceString(value);
  if (!text) return null;
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.valueOf())) return text;
  return parsed.toISOString();
}

function normalizeDescription(value: unknown) {
  if (typeof value !== 'string') return null;
  const plain = htmlToText(value);
  if (plain.length < MIN_DESCRIPTION_LENGTH) return null;
  return truncate(plain, MAX_DESCRIPTION_LENGTH);
}

function firstMatch(input: string, regex: RegExp) {
  const match = regex.exec(input);
  return match?.[1] ? normalizeWhitespace(decodeEntities(match[1])) : null;
}

function extractTitleFromHtml(html: string) {
  return (
    firstMatch(html, /<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ??
    firstMatch(html, /<meta[^>]+name=["']twitter:title["'][^>]*content=["']([^"']+)["'][^>]*>/i) ??
    firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
  );
}

function extractDescriptionFromHtml(html: string) {
  const metaDescription =
    firstMatch(html, /<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']+)["'][^>]*>/i) ??
    firstMatch(html, /<meta[^>]+name=["']description["'][^>]*content=["']([^"']+)["'][^>]*>/i);

  if (metaDescription && metaDescription.length >= MIN_DESCRIPTION_LENGTH) {
    return truncate(metaDescription, MAX_DESCRIPTION_LENGTH);
  }

  const text = htmlToText(html);
  return text.length >= MIN_DESCRIPTION_LENGTH ? truncate(text, MAX_DESCRIPTION_LENGTH) : null;
}

function parseJsonSafely<T>(input: string): T | null {
  try {
    return JSON.parse(input) as T;
  } catch {
    return null;
  }
}

function collectJsonLdCandidates(html: string) {
  const results: unknown[] = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(html)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const parsed = parseJsonSafely<unknown>(raw.trim());
    if (parsed !== null) {
      results.push(parsed);
    }
  }

  return results;
}

function isJobPostingType(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'jobposting';
  }
  if (Array.isArray(value)) {
    return value.some((entry) => isJobPostingType(entry));
  }
  return false;
}

function findJobPosting(data: unknown): Record<string, unknown> | null {
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = findJobPosting(item);
      if (found) return found;
    }
    return null;
  }

  if (!data || typeof data !== 'object') return null;
  const object = data as Record<string, unknown>;
  if (isJobPostingType(object['@type'])) {
    return object;
  }

  for (const value of Object.values(object)) {
    const nested = findJobPosting(value);
    if (nested) return nested;
  }

  return null;
}

function parseLocationFromJobPosting(location: unknown): string | null {
  if (!location) return null;

  if (Array.isArray(location)) {
    for (const entry of location) {
      const parsed: string | null = parseLocationFromJobPosting(entry);
      if (parsed) return parsed;
    }
    return null;
  }

  if (typeof location === 'string') {
    return coerceString(location);
  }

  if (typeof location !== 'object') return null;
  const obj = location as Record<string, unknown>;
  const address = obj.address;
  if (address && typeof address === 'object') {
    const addr = address as Record<string, unknown>;
    const locality = coerceString(addr.addressLocality);
    const region = coerceString(addr.addressRegion);
    const country = coerceString(addr.addressCountry);
    const parts = [locality, region, country].filter((entry): entry is string => Boolean(entry));
    if (parts.length > 0) return parts.join(', ');
  }

  const name = coerceString(obj.name);
  return name;
}

function normalizedFromJsonLd(input: {
  canonical: CanonicalJobUrl;
  html: string;
  jobPosting: Record<string, unknown>;
}): NormalizedJobPayload | null {
  const posting = input.jobPosting;
  const title = coerceString(posting.title) ?? extractTitleFromHtml(input.html);
  const description = normalizeDescription(posting.description) ?? extractDescriptionFromHtml(input.html);

  if (!title || !description) return null;

  const hiringOrganization =
    posting.hiringOrganization && typeof posting.hiringOrganization === 'object'
      ? (posting.hiringOrganization as Record<string, unknown>)
      : null;

  const company = coerceString(hiringOrganization?.name) ?? coerceString(posting.employer) ?? null;
  const location = parseLocationFromJobPosting(posting.jobLocation) ?? coerceString(posting.jobLocationType) ?? null;
  const sourceJobId = input.canonical.sourceJobId ?? coerceString(posting.identifier) ?? null;

  return {
    source: input.canonical.source,
    sourceJobId,
    canonicalUrl: input.canonical.canonicalUrl,
    title,
    company,
    location,
    description,
    employmentType: coerceString(posting.employmentType),
    datePosted: normalizeDateString(posting.datePosted),
    seniority: coerceString(posting.experienceRequirements),
  };
}

function normalizedFromGenericPayload(input: {
  canonical: CanonicalJobUrl;
  payload: Record<string, unknown>;
  htmlHint?: string | null;
}): NormalizedJobPayload | null {
  const payload = input.payload;
  const title =
    coerceString(payload.title) ??
    coerceString(payload.jobTitle) ??
    coerceString(payload.positionName) ??
    (input.htmlHint ? extractTitleFromHtml(input.htmlHint) : null);

  const description =
    normalizeDescription(payload.description) ??
    normalizeDescription(payload.jobDescription) ??
    normalizeDescription(payload.text) ??
    (input.htmlHint ? extractDescriptionFromHtml(input.htmlHint) : null);

  if (!title || !description) return null;

  const sourceJobId =
    input.canonical.sourceJobId ??
    coerceString(payload.jobId) ??
    coerceString(payload.id) ??
    coerceString(payload.reference) ??
    null;

  const companyValue =
    payload.company && typeof payload.company === 'object'
      ? (payload.company as Record<string, unknown>).name
      : payload.company;

  return {
    source: input.canonical.source,
    sourceJobId,
    canonicalUrl: input.canonical.canonicalUrl,
    title,
    company: coerceString(companyValue) ?? coerceString(payload.companyName) ?? coerceString(payload.organization) ?? null,
    location:
      coerceString(payload.location) ??
      coerceString(payload.locationName) ??
      coerceString(payload.city) ??
      coerceString(payload.workplaceType) ??
      null,
    description,
    employmentType: coerceString(payload.employmentType) ?? coerceString(payload.type),
    datePosted: normalizeDateString(payload.datePosted ?? payload.postingDate),
    seniority: coerceString(payload.seniority) ?? coerceString(payload.experienceLevel),
  };
}

function buildNormalizedText(job: NormalizedJobPayload) {
  const rows = [job.title, job.company ?? '', job.location ?? '', job.description]
    .map((entry) => normalizeWhitespace(entry))
    .filter((entry) => entry.length > 0);
  return truncate(rows.join('\n'), MAX_NORMALIZED_TEXT_LENGTH);
}

function buildJobContentHash(job: NormalizedJobPayload) {
  const normalized = {
    title: normalizeWhitespace(job.title).toLowerCase(),
    company: normalizeWhitespace(job.company ?? '').toLowerCase(),
    location: normalizeWhitespace(job.location ?? '').toLowerCase(),
    description: normalizeWhitespace(job.description).toLowerCase(),
    employmentType: normalizeWhitespace(job.employmentType ?? '').toLowerCase(),
    seniority: normalizeWhitespace(job.seniority ?? '').toLowerCase(),
  };

  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

function toSuccess(value: ProviderInternalSuccess): ProviderInternalResult {
  return { ok: true, value };
}

function toFailure(statusCode: number | null, reason: string, meta?: Record<string, unknown>): ProviderInternalResult {
  return { ok: false, statusCode, reason, meta };
}

async function fetchHtml(input: {
  url: string;
  timeoutMs: number;
  headers: Record<string, string>;
}) {
  const response = await fetch(input.url, {
    method: 'GET',
    headers: input.headers,
    signal: AbortSignal.timeout(input.timeoutMs),
  });
  const text = await response.text();
  return { response, text };
}

function baseHeaders() {
  return {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function parseNormalizedFromHtml(canonical: CanonicalJobUrl, html: string) {
  const jsonLdCandidates = collectJsonLdCandidates(html);
  for (const candidate of jsonLdCandidates) {
    const posting = findJobPosting(candidate);
    if (!posting) continue;
    const normalized = normalizedFromJsonLd({ canonical, html, jobPosting: posting });
    if (normalized) {
      return normalized;
    }
  }

  return normalizedFromGenericPayload({
    canonical,
    payload: {},
    htmlHint: html,
  });
}

function containsAny(value: string, patterns: RegExp[]) {
  return patterns.some((pattern) => pattern.test(value));
}

function challengeSignalScore(value: string) {
  const lower = value.toLowerCase();
  let score = 0;
  const sourceBrandPatterns = /(glassdoor|indeed|linkedin|ziprecruiter|wellfound)/i;

  if (containsAny(lower, [/just a moment/i, /attention required/i])) {
    score += 1;
  }

  if (containsAny(lower, [/security\s*\|\s*(glassdoor|indeed|linkedin|ziprecruiter|wellfound)/i])) {
    score += 2;
  }

  if (containsAny(lower, [/checking your browser/i, /checking if the site connection is secure/i])) {
    score += 1;
  }

  if (containsAny(lower, [/security check/i, /human verification/i, /are you (a )?human/i])) {
    score += 1;
  }

  if (containsAny(lower, [/unusual traffic/i, /pardon the interruption/i, /access denied/i])) {
    score += 1;
  }

  if (containsAny(lower, [/enable javascript and cookies to continue/i, /please enable javascript and cookies/i])) {
    score += 1;
  }

  if (containsAny(lower, [/verify you are human/i, /captcha/i, /hcaptcha/i, /recaptcha/i])) {
    score += 1;
  }

  if (containsAny(lower, [/cf-challenge/i, /challenge-platform/i, /cdn-cgi/i, /__cf_chl/i, /cf-ray/i, /ray id/i])) {
    score += 2;
  }

  if (containsAny(lower, [/ddos protection by cloudflare/i])) {
    score += 2;
  }

  if (sourceBrandPatterns.test(lower) && containsAny(lower, [/verify/i, /challenge/i, /security/i])) {
    score += 1;
  }

  return score;
}

export function isLikelyChallengeHtml(html: string) {
  return challengeSignalScore(html) >= 2;
}

export function isLikelyChallengeJobPayload(input: Pick<NormalizedJobPayload, 'title' | 'description'> | null | undefined) {
  if (!input) return false;
  return challengeSignalScore(`${input.title}\n${input.description}`) >= 2;
}

function detectLoginWall(source: CanonicalJobUrl['source'], html: string) {
  const lower = html.toLowerCase();

  const common = [/sign in/i, /log in/i, /create account/i, /join now/i];
  if (source === 'linkedin') {
    return containsAny(lower, [...common, /linkedin.com\/login/i, /join linkedin/i, /new to linkedin/i]);
  }

  if (source === 'glassdoor') {
    return containsAny(lower, [...common, /continue with google/i, /continue with email/i]);
  }

  if (source === 'indeed') {
    return containsAny(lower, [...common, /continue to apply/i, /create an account/i]);
  }

  return containsAny(lower, common);
}

function detectCaptcha(html: string) {
  return isLikelyChallengeHtml(html);
}

function classifyPageResult(input: {
  source: CanonicalJobUrl['source'];
  statusCode: number | null;
  html: string;
  normalized: NormalizedJobPayload | null;
}) {
  if (input.statusCode === 404) {
    return { pageAccess: 'not_found' as PageAccess, responseClass: 'not_found' as ResponseClass };
  }

  if (input.statusCode === 401 || input.statusCode === 403) {
    return { pageAccess: 'blocked' as PageAccess, responseClass: 'hard_block' as ResponseClass };
  }

  if (input.html.length < 350) {
    return { pageAccess: 'blocked' as PageAccess, responseClass: 'empty' as ResponseClass };
  }

  if (detectCaptcha(input.html)) {
    return { pageAccess: 'blocked' as PageAccess, responseClass: 'captcha' as ResponseClass };
  }

  const hasLoginWall = detectLoginWall(input.source, input.html);
  if (hasLoginWall) {
    if (input.normalized) {
      return { pageAccess: 'soft_wall' as PageAccess, responseClass: 'ok_partial' as ResponseClass };
    }

    return {
      pageAccess: input.source === 'linkedin' ? ('hard_wall' as PageAccess) : ('soft_wall' as PageAccess),
      responseClass: 'login_wall' as ResponseClass,
    };
  }

  if (input.normalized) {
    return { pageAccess: 'public_ok' as PageAccess, responseClass: 'ok_full' as ResponseClass };
  }

  return { pageAccess: 'soft_wall' as PageAccess, responseClass: 'ok_partial' as ResponseClass };
}

function isBlockedResponseClass(responseClass: ResponseClass) {
  return responseClass === 'captcha' || responseClass === 'hard_block' || responseClass === 'empty';
}

function extractProviderMetaStatus(meta: Record<string, unknown>) {
  const status = meta.status;
  return typeof status === 'number' && Number.isFinite(status) ? status : null;
}

async function runHttpFetch(canonical: CanonicalJobUrl, log?: FastifyBaseLogger): Promise<ProviderInternalResult> {
  if (!env.JOB_SCRAPER_HTTP_FIRST) {
    return toFailure(409, 'HTTP fetch disabled by policy', {
      source: canonical.source,
    });
  }

  try {
    const response = await fetchHtml({
      url: canonical.canonicalUrl,
      timeoutMs: env.JOB_SCRAPER_HTTP_TIMEOUT_MS,
      headers: baseHeaders(),
    });

    const normalized = response.response.ok ? parseNormalizedFromHtml(canonical, response.text) : null;
    const classified = classifyPageResult({
      source: canonical.source,
      statusCode: response.response.status,
      html: response.text,
      normalized,
    });

    if (canonical.source === 'linkedin' && env.JOB_SCRAPER_LINKEDIN_PUBLIC_ONLY && classified.responseClass === 'login_wall') {
      return toFailure(422, 'LinkedIn URL is not public in current scope', {
        source: canonical.source,
        pageAccess: classified.pageAccess,
        responseClass: classified.responseClass,
      });
    }

    if (!response.response.ok) {
      return toFailure(response.response.status, 'HTTP fetch returned non-2xx', {
        source: canonical.source,
        status: response.response.status,
        pageAccess: classified.pageAccess,
        responseClass: classified.responseClass,
      });
    }

    if (!/<html/i.test(response.text)) {
      return toFailure(422, 'HTTP fetch returned non-HTML payload', {
        source: canonical.source,
        pageAccess: classified.pageAccess,
        responseClass: classified.responseClass,
      });
    }

    if (isBlockedResponseClass(classified.responseClass)) {
      return toFailure(response.response.status, 'HTTP fetch returned blocked or challenge page', {
        source: canonical.source,
        status: response.response.status,
        pageAccess: classified.pageAccess,
        responseClass: classified.responseClass,
      });
    }

    if (normalized && isLikelyChallengeJobPayload(normalized)) {
      return toFailure(422, 'HTTP fetch payload matched security challenge markers', {
        source: canonical.source,
        status: response.response.status,
        pageAccess: classified.pageAccess,
        responseClass: classified.responseClass,
      });
    }

    if (!normalized) {
      return toFailure(422, 'HTTP fetch payload does not contain enough job content', {
        source: canonical.source,
        pageAccess: classified.pageAccess,
        responseClass: classified.responseClass,
      });
    }

    return toSuccess({
      provider: 'http_fetch',
      normalized,
      normalizedText: buildNormalizedText(normalized),
      rawPayload: {
        method: 'http_fetch',
        status: response.response.status,
        html: truncate(response.text, 25_000),
      },
      providerRequestId: null,
      providerMeta: {
        method: 'http_fetch',
        status: response.response.status,
        pageAccess: classified.pageAccess,
        responseClass: classified.responseClass,
      },
    });
  } catch (error) {
    log?.debug({ error }, 'http fetch failed');
    return toFailure(502, 'HTTP fetch failed by timeout or network error', {
      source: canonical.source,
      message: error instanceof Error ? error.message : 'unknown_error',
    });
  }
}

function isBrowserFallbackAllowed(source: CanonicalJobUrl['source']) {
  if (!env.JOB_SCRAPER_ENABLE_BROWSER_FALLBACK) return false;
  return env.JOB_SCRAPER_BROWSER_FALLBACK_SOURCES_LIST.includes(source);
}

function shouldAttemptBrowserFallback(canonical: CanonicalJobUrl, primaryFailure: ProviderInternalResult) {
  if (primaryFailure.ok) return false;
  if (!isBrowserFallbackAllowed(canonical.source)) return false;
  if (primaryFailure.statusCode === 404) return false;

  if (
    canonical.source === 'linkedin' &&
    env.JOB_SCRAPER_LINKEDIN_PUBLIC_ONLY &&
    primaryFailure.reason.toLowerCase().includes('not public')
  ) {
    return false;
  }

  return true;
}

async function runBrowserFallback(canonical: CanonicalJobUrl, log?: FastifyBaseLogger): Promise<ProviderInternalResult> {
  if (!isBrowserFallbackAllowed(canonical.source)) {
    return toFailure(409, 'Browser fallback disabled for this source', {
      source: canonical.source,
    });
  }

  const rendered = await fetchRenderedHtml({
    source: canonical.source,
    url: canonical.canonicalUrl,
    timeoutMs: env.JOB_SCRAPER_BROWSER_TIMEOUT_MS,
    log,
  });

  if (!rendered.ok) {
    return toFailure(rendered.statusCode, 'Browser fallback failed', {
      source: canonical.source,
      message: rendered.reason,
    });
  }

  const normalized = parseNormalizedFromHtml(canonical, rendered.html);
  const classified = classifyPageResult({
    source: canonical.source,
    statusCode: rendered.statusCode,
    html: rendered.html,
    normalized,
  });

  if (rendered.statusCode !== null && (rendered.statusCode < 200 || rendered.statusCode >= 300)) {
    return toFailure(rendered.statusCode, 'Browser fallback returned non-2xx', {
      source: canonical.source,
      status: rendered.statusCode,
      pageAccess: classified.pageAccess,
      responseClass: classified.responseClass,
      finalUrl: rendered.finalUrl,
    });
  }

  if (canonical.source === 'linkedin' && env.JOB_SCRAPER_LINKEDIN_PUBLIC_ONLY && classified.responseClass === 'login_wall') {
    return toFailure(422, 'LinkedIn URL is not public in current scope', {
      source: canonical.source,
      pageAccess: classified.pageAccess,
      responseClass: classified.responseClass,
      finalUrl: rendered.finalUrl,
    });
  }

  if (isBlockedResponseClass(classified.responseClass)) {
    return toFailure(rendered.statusCode ?? 422, 'Browser fallback returned blocked or challenge page', {
      source: canonical.source,
      status: rendered.statusCode,
      pageAccess: classified.pageAccess,
      responseClass: classified.responseClass,
      finalUrl: rendered.finalUrl,
    });
  }

  if (normalized && isLikelyChallengeJobPayload(normalized)) {
    return toFailure(422, 'Browser fallback payload matched security challenge markers', {
      source: canonical.source,
      status: rendered.statusCode,
      pageAccess: classified.pageAccess,
      responseClass: classified.responseClass,
      finalUrl: rendered.finalUrl,
    });
  }

  if (!normalized) {
    return toFailure(422, 'Browser fallback payload does not contain enough job content', {
      source: canonical.source,
      pageAccess: classified.pageAccess,
      responseClass: classified.responseClass,
      status: rendered.statusCode,
      finalUrl: rendered.finalUrl,
    });
  }

  return toSuccess({
    provider: 'browser_fallback',
    normalized,
    normalizedText: buildNormalizedText(normalized),
    rawPayload: {
      method: 'browser_fallback',
      status: rendered.statusCode,
      title: rendered.title,
      finalUrl: rendered.finalUrl,
      html: truncate(rendered.html, 30_000),
    },
    providerRequestId: null,
    providerMeta: {
      method: 'browser_fallback',
      status: rendered.statusCode,
      durationMs: rendered.durationMs,
      pageAccess: classified.pageAccess,
      responseClass: classified.responseClass,
      finalUrl: rendered.finalUrl,
    },
  });
}

export async function fetchJobWithProviderFallback(input: {
  canonical: CanonicalJobUrl;
  log?: FastifyBaseLogger;
}): Promise<JobProviderSuccess | JobProviderFailure> {
  const attempts: JobProviderAttempt[] = [];

  const primaryStartedAt = Date.now();
  const primary = await runHttpFetch(input.canonical, input.log);
  attempts.push({
    provider: 'http_fetch',
    ok: primary.ok,
    statusCode: primary.ok ? extractProviderMetaStatus(primary.value.providerMeta) : primary.statusCode,
    reason: primary.ok ? 'ok' : primary.reason,
    durationMs: Date.now() - primaryStartedAt,
    meta: primary.ok ? primary.value.providerMeta : primary.meta,
  });

  if (primary.ok) {
    return {
      ok: true,
      providerUsed: primary.value.provider,
      attempts,
      normalized: primary.value.normalized,
      normalizedText: primary.value.normalizedText,
      jobContentHash: buildJobContentHash(primary.value.normalized),
      rawPayload: primary.value.rawPayload,
      providerRequestId: primary.value.providerRequestId,
      providerMeta: primary.value.providerMeta,
    };
  }

  if (!shouldAttemptBrowserFallback(input.canonical, primary)) {
    return {
      ok: false,
      attempts,
      code: 'provider_failed',
      message: 'HTTP fetch failed and browser fallback is not allowed by policy',
    };
  }

  const fallbackStartedAt = Date.now();
  const fallback = await runBrowserFallback(input.canonical, input.log);
  attempts.push({
    provider: 'browser_fallback',
    ok: fallback.ok,
    statusCode: fallback.ok ? extractProviderMetaStatus(fallback.value.providerMeta) : fallback.statusCode,
    reason: fallback.ok ? 'ok' : fallback.reason,
    durationMs: Date.now() - fallbackStartedAt,
    meta: fallback.ok ? fallback.value.providerMeta : fallback.meta,
  });

  if (fallback.ok) {
    return {
      ok: true,
      providerUsed: fallback.value.provider,
      attempts,
      normalized: fallback.value.normalized,
      normalizedText: fallback.value.normalizedText,
      jobContentHash: buildJobContentHash(fallback.value.normalized),
      rawPayload: fallback.value.rawPayload,
      providerRequestId: fallback.value.providerRequestId,
      providerMeta: fallback.value.providerMeta,
    };
  }

  return {
    ok: false,
    attempts,
    code: 'provider_failed',
    message: 'All internal fetching strategies failed to parse vacancy URL',
  };
}
