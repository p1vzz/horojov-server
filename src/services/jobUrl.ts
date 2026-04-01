import { createHash } from 'node:crypto';

export type SupportedJobSource = 'linkedin' | 'indeed' | 'glassdoor' | 'ziprecruiter' | 'wellfound';
export type JobProviderName = 'http_fetch' | 'browser_fallback';

export type JobProviderRouting = {
  primary: JobProviderName;
  fallback: JobProviderName;
};

export type JobUrlValidationCode =
  | 'invalid_url'
  | 'unsupported_protocol'
  | 'unsupported_source'
  | 'unsupported_path';

export type JobUrlValidationResult =
  | {
      ok: true;
      data: CanonicalJobUrl;
    }
  | {
      ok: false;
      code: JobUrlValidationCode;
      message: string;
    };

export type CanonicalJobUrl = {
  source: SupportedJobSource;
  normalizedUrl: string;
  canonicalUrl: string;
  canonicalUrlHash: string;
  host: string;
  sourceJobId: string | null;
  routing: JobProviderRouting;
};

const ROUTING_BY_SOURCE: Record<SupportedJobSource, JobProviderRouting> = {
  linkedin: { primary: 'http_fetch', fallback: 'browser_fallback' },
  indeed: { primary: 'http_fetch', fallback: 'browser_fallback' },
  glassdoor: { primary: 'http_fetch', fallback: 'browser_fallback' },
  ziprecruiter: { primary: 'http_fetch', fallback: 'browser_fallback' },
  wellfound: { primary: 'http_fetch', fallback: 'browser_fallback' },
};

const HOST_PATTERNS: Array<{ source: SupportedJobSource; domain: string }> = [
  { source: 'linkedin', domain: 'linkedin.com' },
  { source: 'indeed', domain: 'indeed.com' },
  { source: 'glassdoor', domain: 'glassdoor.com' },
  { source: 'ziprecruiter', domain: 'ziprecruiter.com' },
  { source: 'wellfound', domain: 'wellfound.com' },
];

const TRACKING_PARAM_REGEXES = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_/i,
  /^ref$/i,
  /^refid$/i,
  /^trk/i,
  /^tracking/i,
];

function normalizeHostname(hostname: string) {
  return hostname.trim().toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
}

function normalizePathname(pathname: string) {
  const collapsed = pathname.replace(/\/{2,}/g, '/');
  const normalized = collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function parseUrl(rawUrl: string) {
  const normalizedInput = rawUrl.trim();
  if (normalizedInput.length < 8) {
    return null;
  }

  const candidate = /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(normalizedInput)
    ? normalizedInput
    : `https://${normalizedInput}`;

  try {
    return new URL(candidate);
  } catch {
    return null;
  }
}

function isTrackingParam(param: string) {
  return TRACKING_PARAM_REGEXES.some((regex) => regex.test(param));
}

function normalizedSearchParams(params: URLSearchParams, allowedKeys?: ReadonlySet<string>) {
  const rows: Array<[string, string]> = [];
  for (const [key, value] of params.entries()) {
    if (allowedKeys && !allowedKeys.has(key)) continue;
    if (isTrackingParam(key)) continue;
    const normalizedValue = value.trim();
    if (normalizedValue.length === 0) continue;
    rows.push([key, normalizedValue]);
  }

  rows.sort((a, b) => {
    if (a[0] === b[0]) {
      return a[1].localeCompare(b[1]);
    }
    return a[0].localeCompare(b[0]);
  });

  const output = new URLSearchParams();
  const dedupe = new Set<string>();
  for (const [key, value] of rows) {
    const rowKey = `${key}\u0000${value}`;
    if (dedupe.has(rowKey)) continue;
    dedupe.add(rowKey);
    output.append(key, value);
  }
  return output;
}

function hostMatches(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

function resolveSource(host: string): SupportedJobSource | null {
  for (const matcher of HOST_PATTERNS) {
    if (hostMatches(host, matcher.domain)) {
      return matcher.source;
    }
  }
  return null;
}

function canonicalizeLinkedIn(url: URL) {
  const pathname = normalizePathname(url.pathname);
  const idMatch = pathname.match(/\/jobs\/view\/(?:[^/]+-)?(\d+)/i);
  if (!idMatch || !idMatch[1]) {
    return {
      ok: false as const,
      code: 'unsupported_path' as const,
      message: 'LinkedIn URL must point to a concrete job posting',
    };
  }

  const sourceJobId = idMatch[1];
  return {
    ok: true as const,
    sourceJobId,
    canonicalPath: `/jobs/view/${sourceJobId}`,
    canonicalQuery: new URLSearchParams(),
  };
}

function canonicalizeIndeed(url: URL) {
  const pathname = normalizePathname(url.pathname);
  const search = url.searchParams;
  const jobId = search.get('jk')?.trim() || search.get('vjk')?.trim() || null;
  const pathLooksLikeJob = pathname.includes('/viewjob') || pathname.includes('/job/');

  if (!pathLooksLikeJob) {
    return {
      ok: false as const,
      code: 'unsupported_path' as const,
      message: 'Indeed URL must point to a concrete job posting',
    };
  }

  if (jobId) {
    const query = new URLSearchParams();
    query.set('jk', jobId);

    return {
      ok: true as const,
      sourceJobId: jobId,
      canonicalPath: '/viewjob',
      canonicalQuery: query,
    };
  }

  return {
    ok: true as const,
    sourceJobId: null,
    canonicalPath: pathname,
    canonicalQuery: normalizedSearchParams(search),
  };
}

function canonicalizeGlassdoor(url: URL) {
  const pathname = normalizePathname(url.pathname);
  const search = url.searchParams;
  const jobId = search.get('jl')?.trim() || null;
  const hasJobListingPath = pathname.includes('/job-listing');

  if (!hasJobListingPath && !jobId) {
    return {
      ok: false as const,
      code: 'unsupported_path' as const,
      message: 'Glassdoor URL must point to a concrete job listing',
    };
  }

  if (jobId) {
    const query = new URLSearchParams();
    query.set('jl', jobId);
    return {
      ok: true as const,
      sourceJobId: jobId,
      canonicalPath: '/job-listing',
      canonicalQuery: query,
    };
  }

  return {
    ok: true as const,
    sourceJobId: null,
    canonicalPath: pathname,
    canonicalQuery: normalizedSearchParams(search),
  };
}

function canonicalizeZipRecruiter(url: URL) {
  const pathname = normalizePathname(url.pathname);
  const pathLooksLikeJob = pathname.includes('/jobs/') || pathname.includes('/job/');

  if (!pathLooksLikeJob) {
    return {
      ok: false as const,
      code: 'unsupported_path' as const,
      message: 'ZipRecruiter URL must point to a concrete job posting',
    };
  }

  const segments = pathname.split('/').filter(Boolean);
  const lastSegment = segments.length > 0 ? (segments[segments.length - 1] ?? '') : '';
  const idMatch = lastSegment ? lastSegment.match(/-([a-z0-9]{6,})$/i) : null;

  return {
    ok: true as const,
    sourceJobId: idMatch?.[1] ?? null,
    canonicalPath: pathname,
    canonicalQuery: normalizedSearchParams(url.searchParams, new Set(['lvk', 'sid'])),
  };
}

function canonicalizeWellfound(url: URL) {
  const pathname = normalizePathname(url.pathname);
  const pathLooksLikeJob = pathname.includes('/jobs/') || pathname.includes('/job/');
  if (!pathLooksLikeJob) {
    return {
      ok: false as const,
      code: 'unsupported_path' as const,
      message: 'Wellfound URL must point to a concrete job posting',
    };
  }

  const segments = pathname.split('/').filter(Boolean);
  const lastSegment = segments.length > 0 ? (segments[segments.length - 1] ?? '') : '';
  const numericIdMatch = lastSegment.match(/(\d{5,})$/);

  return {
    ok: true as const,
    sourceJobId: numericIdMatch?.[1] ?? null,
    canonicalPath: pathname,
    canonicalQuery: normalizedSearchParams(url.searchParams),
  };
}

export function getProviderRoutingForSource(source: SupportedJobSource) {
  return ROUTING_BY_SOURCE[source];
}

export function validateAndCanonicalizeJobUrl(rawUrl: string): JobUrlValidationResult {
  const parsed = parseUrl(rawUrl);
  if (!parsed) {
    return {
      ok: false,
      code: 'invalid_url',
      message: 'Invalid job URL',
    };
  }

  if (parsed.protocol !== 'https:') {
    return {
      ok: false,
      code: 'unsupported_protocol',
      message: 'Only https URLs are supported',
    };
  }

  const host = normalizeHostname(parsed.hostname);
  const source = resolveSource(host);
  if (!source) {
    return {
      ok: false,
      code: 'unsupported_source',
      message: 'Unsupported vacancy source',
    };
  }

  parsed.hash = '';
  parsed.hostname = host;

  const canonical = (() => {
    switch (source) {
      case 'linkedin':
        return canonicalizeLinkedIn(parsed);
      case 'indeed':
        return canonicalizeIndeed(parsed);
      case 'glassdoor':
        return canonicalizeGlassdoor(parsed);
      case 'ziprecruiter':
        return canonicalizeZipRecruiter(parsed);
      case 'wellfound':
        return canonicalizeWellfound(parsed);
    }
  })();

  if (!canonical.ok) {
    return canonical;
  }

  const canonicalQueryString = canonical.canonicalQuery.toString();
  const canonicalUrl = `https://${host}${canonical.canonicalPath}${canonicalQueryString ? `?${canonicalQueryString}` : ''}`;
  const normalizedUrl = parsed.toString();

  return {
    ok: true,
    data: {
      source,
      normalizedUrl,
      canonicalUrl,
      canonicalUrlHash: createHash('sha256').update(canonicalUrl).digest('hex'),
      host,
      sourceJobId: canonical.sourceJobId,
      routing: getProviderRoutingForSource(source),
    },
  };
}
