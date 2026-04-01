import { env } from '../config/env.js';
import { getCollections } from '../db/mongo.js';
import { deleteCachedKey, getCachedJson, setCachedJson } from './cacheStore.js';
import type { SupportedJobSource } from './jobUrl.js';

const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 24 * 14;
const CONFIDENCE_MIN_SENTINEL = 1_000_000;
const CONFIDENCE_MAX_SENTINEL = -1_000_000;
const JOB_METRICS_CACHE_NAMESPACE = 'jobs:metrics:v1';

type CounterMap = Record<string, number>;

type SourceMetricsAccumulator = {
  source: SupportedJobSource;
  rawFetches: number;
  negativeEvents: number;
  parsedDocs: number;
  providerCounts: CounterMap;
  responseClassCounts: CounterMap;
  pageAccessCounts: CounterMap;
  negativeCounts: CounterMap;
  confidenceSum: number;
  confidenceSamples: number;
  confidenceMin: number | null;
  confidenceMax: number | null;
};

type ParsedMetricsAggregateRow = {
  _id: {
    source: unknown;
  };
  count: number;
  confidenceSamples: number;
  confidenceSum: number;
  confidenceMinCandidate: number;
  confidenceMaxCandidate: number;
};

export type JobMetricsSourceReport = {
  source: SupportedJobSource;
  rawFetches: number;
  negativeEvents: number;
  parsedDocs: number;
  successRatePct: number | null;
  browserFallbackRatePct: number | null;
  providerCounts: CounterMap;
  responseClassCounts: CounterMap;
  pageAccessCounts: CounterMap;
  negativeCounts: CounterMap;
  parseConfidence: {
    samples: number;
    average: number | null;
    min: number | null;
    max: number | null;
  };
};

export type JobMetricsReport = {
  window: {
    hours: number;
    from: string;
    to: string;
  };
  totals: {
    rawFetches: number;
    negativeEvents: number;
    parsedDocs: number;
  };
  sources: JobMetricsSourceReport[];
};

export type JobMetricsAlertSeverity = 'warn' | 'critical';

export type JobMetricsAlert = {
  id: string;
  severity: JobMetricsAlertSeverity;
  source: SupportedJobSource;
  metric: 'blocked_rate' | 'browser_fallback_rate' | 'success_rate';
  valuePct: number;
  thresholdPct: number;
  message: string;
};

export type JobMetricsAlertsReport = {
  generatedAt: string;
  window: JobMetricsReport['window'];
  thresholds: {
    minEvents: number;
    blockedRatePct: number;
    browserFallbackRatePct: number;
    successRateMinPct: number;
  };
  hasAlerts: boolean;
  alerts: JobMetricsAlert[];
};

const inFlightMetricsCollection = new Map<number, Promise<JobMetricsReport>>();
const knownMetricsWindows = new Set<number>();

const SUPPORTED_SOURCES: SupportedJobSource[] = ['linkedin', 'wellfound', 'ziprecruiter', 'indeed', 'glassdoor'];

function asSource(value: unknown): SupportedJobSource | null {
  if (typeof value !== 'string') return null;
  return SUPPORTED_SOURCES.includes(value as SupportedJobSource) ? (value as SupportedJobSource) : null;
}

function emptySourceMetrics(source: SupportedJobSource): SourceMetricsAccumulator {
  return {
    source,
    rawFetches: 0,
    negativeEvents: 0,
    parsedDocs: 0,
    providerCounts: {},
    responseClassCounts: {},
    pageAccessCounts: {},
    negativeCounts: {},
    confidenceSum: 0,
    confidenceSamples: 0,
    confidenceMin: null,
    confidenceMax: null,
  };
}

function incrementCounterBy(counter: CounterMap, key: string, count: number) {
  const normalized = key.trim();
  if (normalized.length === 0 || count <= 0) return;
  counter[normalized] = (counter[normalized] ?? 0) + count;
}

function round2(value: number) {
  return Math.round(value * 100) / 100;
}

function getSourceOrder() {
  const sourceOrder = env.JOB_SCRAPER_SOURCE_PRIORITY_LIST.map((value) => asSource(value)).filter(
    (value): value is SupportedJobSource => value !== null
  );
  const configuredSources = env.JOB_SCRAPER_ENABLED_SOURCES_LIST.map((value) => asSource(value)).filter(
    (value): value is SupportedJobSource => value !== null
  );
  return Array.from(new Set([...sourceOrder, ...configuredSources, ...SUPPORTED_SOURCES]));
}

function sanitizeWindowHours(value: number) {
  const intValue = Math.trunc(value);
  if (!Number.isFinite(intValue)) return env.JOB_METRICS_ALERT_WINDOW_HOURS;
  return Math.min(MAX_WINDOW_HOURS, Math.max(MIN_WINDOW_HOURS, intValue));
}

export function resolveMetricsWindowHours(windowHours?: number | null) {
  if (typeof windowHours === 'number') {
    return sanitizeWindowHours(windowHours);
  }
  return sanitizeWindowHours(env.JOB_METRICS_ALERT_WINDOW_HOURS);
}

function metricsCacheKey(windowHours: number) {
  return `${JOB_METRICS_CACHE_NAMESPACE}:${windowHours}`;
}

async function getCachedJobMetricsReport(windowHours: number) {
  if (!env.CACHE_JOB_METRICS_SNAPSHOT_ENABLED) return null;
  return getCachedJson<JobMetricsReport>(metricsCacheKey(windowHours));
}

async function setCachedJobMetricsReport(windowHours: number, report: JobMetricsReport) {
  if (!env.CACHE_JOB_METRICS_SNAPSHOT_ENABLED) return;
  knownMetricsWindows.add(windowHours);
  await setCachedJson(
    metricsCacheKey(windowHours),
    report,
    env.CACHE_JOB_METRICS_SNAPSHOT_TTL_SECONDS * 1000
  );
}

export async function clearJobMetricsSnapshotCache(windowHours?: number) {
  if (typeof windowHours === 'number') {
    const normalizedWindowHours = resolveMetricsWindowHours(windowHours);
    knownMetricsWindows.delete(normalizedWindowHours);
    await deleteCachedKey(metricsCacheKey(normalizedWindowHours));
    return;
  }

  const cachedWindows = Array.from(knownMetricsWindows);
  knownMetricsWindows.clear();
  await Promise.all(cachedWindows.map((hours) => deleteCachedKey(metricsCacheKey(hours))));
}

export async function collectJobMetrics(
  windowHoursInput?: number,
  options: { forceRefresh?: boolean } = {}
): Promise<JobMetricsReport> {
  const windowHours = resolveMetricsWindowHours(windowHoursInput);
  if (!options.forceRefresh) {
    const cached = await getCachedJobMetricsReport(windowHours);
    if (cached) return cached;

    const inFlight = inFlightMetricsCollection.get(windowHours);
    if (inFlight) return inFlight;
  }

  const collectPromise = (async () => {
    const now = new Date();
    const from = new Date(now.getTime() - windowHours * 60 * 60 * 1000);
    const collections = await getCollections();

    const [rawGrouped, negativeGrouped, parsedGrouped] = await Promise.all([
      collections.jobsRaw
        .aggregate<{
          _id: {
            source: unknown;
            provider: unknown;
            responseClass: unknown;
            pageAccess: unknown;
          };
          count: number;
        }>([
          { $match: { updatedAt: { $gte: from } } },
          {
            $group: {
              _id: {
                source: '$source',
                provider: '$provider',
                responseClass: '$providerMeta.responseClass',
                pageAccess: '$providerMeta.pageAccess',
              },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      collections.jobFetchNegativeCache
        .aggregate<{
          _id: {
            source: unknown;
            status: unknown;
          };
          count: number;
        }>([
          { $match: { updatedAt: { $gte: from } } },
          {
            $group: {
              _id: {
                source: '$source',
                status: '$status',
              },
              count: { $sum: 1 },
            },
          },
        ])
        .toArray(),
      collections.jobsParsed
        .aggregate<ParsedMetricsAggregateRow>([
          { $match: { updatedAt: { $gte: from } } },
          {
            $group: {
              _id: {
                source: '$source',
              },
              count: { $sum: 1 },
              confidenceSamples: {
                $sum: {
                  $cond: [{ $isNumber: '$confidence' }, 1, 0],
                },
              },
              confidenceSum: {
                $sum: {
                  $cond: [{ $isNumber: '$confidence' }, '$confidence', 0],
                },
              },
              confidenceMinCandidate: {
                $min: {
                  $cond: [
                    { $isNumber: '$confidence' },
                    '$confidence',
                    CONFIDENCE_MIN_SENTINEL,
                  ],
                },
              },
              confidenceMaxCandidate: {
                $max: {
                  $cond: [
                    { $isNumber: '$confidence' },
                    '$confidence',
                    CONFIDENCE_MAX_SENTINEL,
                  ],
                },
              },
            },
          },
        ])
        .toArray(),
    ]);

    const sourceOrder = getSourceOrder();
    const sourceRank = new Map<SupportedJobSource, number>();
    sourceOrder.forEach((source, index) => sourceRank.set(source, index));

    const metricsMap = new Map<SupportedJobSource, SourceMetricsAccumulator>();
    for (const source of sourceOrder) {
      metricsMap.set(source, emptySourceMetrics(source));
    }

    const getMetricsForSource = (source: SupportedJobSource) => {
      const existing = metricsMap.get(source);
      if (existing) return existing;
      const created = emptySourceMetrics(source);
      metricsMap.set(source, created);
      return created;
    };

    for (const row of rawGrouped) {
      const source = asSource(row._id.source);
      if (!source) continue;

      const metrics = getMetricsForSource(source);
      const count = Math.max(0, Math.trunc(row.count));
      if (count === 0) continue;
      metrics.rawFetches += count;

      const provider = typeof row._id.provider === 'string' ? row._id.provider : 'unknown';
      const responseClass = typeof row._id.responseClass === 'string' ? row._id.responseClass : 'unknown';
      const pageAccess = typeof row._id.pageAccess === 'string' ? row._id.pageAccess : 'unknown';
      incrementCounterBy(metrics.providerCounts, provider, count);
      incrementCounterBy(metrics.responseClassCounts, responseClass, count);
      incrementCounterBy(metrics.pageAccessCounts, pageAccess, count);
    }

    for (const row of negativeGrouped) {
      const source = asSource(row._id.source);
      if (!source) continue;

      const metrics = getMetricsForSource(source);
      const count = Math.max(0, Math.trunc(row.count));
      if (count === 0) continue;
      metrics.negativeEvents += count;

      const status = typeof row._id.status === 'string' ? row._id.status : 'unknown';
      incrementCounterBy(metrics.negativeCounts, status, count);
    }

    for (const row of parsedGrouped) {
      const source = asSource(row._id.source);
      if (!source) continue;

      const metrics = getMetricsForSource(source);
      const count = Math.max(0, Math.trunc(row.count));
      if (count === 0) continue;
      metrics.parsedDocs += count;

      const confidenceSamples = Math.max(0, Math.trunc(row.confidenceSamples));
      if (confidenceSamples <= 0) continue;

      metrics.confidenceSamples += confidenceSamples;
      if (typeof row.confidenceSum === 'number' && Number.isFinite(row.confidenceSum)) {
        metrics.confidenceSum += row.confidenceSum;
      }
      if (
        typeof row.confidenceMinCandidate === 'number' &&
        row.confidenceMinCandidate !== CONFIDENCE_MIN_SENTINEL &&
        Number.isFinite(row.confidenceMinCandidate)
      ) {
        metrics.confidenceMin =
          metrics.confidenceMin === null
            ? row.confidenceMinCandidate
            : Math.min(metrics.confidenceMin, row.confidenceMinCandidate);
      }
      if (
        typeof row.confidenceMaxCandidate === 'number' &&
        row.confidenceMaxCandidate !== CONFIDENCE_MAX_SENTINEL &&
        Number.isFinite(row.confidenceMaxCandidate)
      ) {
        metrics.confidenceMax =
          metrics.confidenceMax === null
            ? row.confidenceMaxCandidate
            : Math.max(metrics.confidenceMax, row.confidenceMaxCandidate);
      }
    }

    const sources = Array.from(metricsMap.values())
      .sort((a, b) => (sourceRank.get(a.source) ?? 999) - (sourceRank.get(b.source) ?? 999))
      .map((entry): JobMetricsSourceReport => {
        const totalEvents = entry.rawFetches + entry.negativeEvents;
        const browserFallbackCount = entry.providerCounts['browser_fallback'] ?? 0;

        return {
          source: entry.source,
          rawFetches: entry.rawFetches,
          negativeEvents: entry.negativeEvents,
          parsedDocs: entry.parsedDocs,
          successRatePct: totalEvents > 0 ? round2((entry.rawFetches / totalEvents) * 100) : null,
          browserFallbackRatePct: entry.rawFetches > 0 ? round2((browserFallbackCount / entry.rawFetches) * 100) : null,
          providerCounts: entry.providerCounts,
          responseClassCounts: entry.responseClassCounts,
          pageAccessCounts: entry.pageAccessCounts,
          negativeCounts: entry.negativeCounts,
          parseConfidence: {
            samples: entry.confidenceSamples,
            average: entry.confidenceSamples > 0 ? round2(entry.confidenceSum / entry.confidenceSamples) : null,
            min: entry.confidenceMin,
            max: entry.confidenceMax,
          },
        };
      });

    const totals = sources.reduce(
      (acc, item) => ({
        rawFetches: acc.rawFetches + item.rawFetches,
        negativeEvents: acc.negativeEvents + item.negativeEvents,
        parsedDocs: acc.parsedDocs + item.parsedDocs,
      }),
      { rawFetches: 0, negativeEvents: 0, parsedDocs: 0 }
    );

    const report = {
      window: {
        hours: windowHours,
        from: from.toISOString(),
        to: now.toISOString(),
      },
      totals,
      sources,
    } satisfies JobMetricsReport;

    await setCachedJobMetricsReport(windowHours, report);
    return report;
  })();

  if (options.forceRefresh) {
    return collectPromise;
  }

  inFlightMetricsCollection.set(windowHours, collectPromise);
  try {
    return await collectPromise;
  } finally {
    inFlightMetricsCollection.delete(windowHours);
  }
}

export function evaluateJobMetricsAlerts(metrics: JobMetricsReport): JobMetricsAlertsReport {
  const alerts: JobMetricsAlert[] = [];
  const minEvents = env.JOB_METRICS_ALERT_MIN_EVENTS;

  for (const sourceMetrics of metrics.sources) {
    const totalEvents = sourceMetrics.rawFetches + sourceMetrics.negativeEvents;
    if (totalEvents < minEvents) continue;

    const blockedCount = sourceMetrics.negativeCounts['blocked'] ?? 0;
    const blockedRatePct = round2((blockedCount / totalEvents) * 100);
    if (blockedRatePct > env.JOB_METRICS_ALERT_BLOCKED_RATE_PCT) {
      alerts.push({
        id: `${sourceMetrics.source}:blocked_rate`,
        severity: blockedRatePct >= env.JOB_METRICS_ALERT_BLOCKED_RATE_PCT * 1.5 ? 'critical' : 'warn',
        source: sourceMetrics.source,
        metric: 'blocked_rate',
        valuePct: blockedRatePct,
        thresholdPct: env.JOB_METRICS_ALERT_BLOCKED_RATE_PCT,
        message: `${sourceMetrics.source} blocked rate is ${blockedRatePct}% (threshold ${env.JOB_METRICS_ALERT_BLOCKED_RATE_PCT}%).`,
      });
    }

    if (
      sourceMetrics.browserFallbackRatePct !== null &&
      sourceMetrics.browserFallbackRatePct > env.JOB_METRICS_ALERT_BROWSER_FALLBACK_RATE_PCT
    ) {
      alerts.push({
        id: `${sourceMetrics.source}:browser_fallback_rate`,
        severity:
          sourceMetrics.browserFallbackRatePct >= env.JOB_METRICS_ALERT_BROWSER_FALLBACK_RATE_PCT * 1.5
            ? 'critical'
            : 'warn',
        source: sourceMetrics.source,
        metric: 'browser_fallback_rate',
        valuePct: sourceMetrics.browserFallbackRatePct,
        thresholdPct: env.JOB_METRICS_ALERT_BROWSER_FALLBACK_RATE_PCT,
        message: `${sourceMetrics.source} browser fallback rate is ${sourceMetrics.browserFallbackRatePct}% (threshold ${env.JOB_METRICS_ALERT_BROWSER_FALLBACK_RATE_PCT}%).`,
      });
    }

    if (sourceMetrics.successRatePct !== null && sourceMetrics.successRatePct < env.JOB_METRICS_ALERT_SUCCESS_RATE_MIN_PCT) {
      alerts.push({
        id: `${sourceMetrics.source}:success_rate`,
        severity:
          sourceMetrics.successRatePct <= env.JOB_METRICS_ALERT_SUCCESS_RATE_MIN_PCT * 0.7 ? 'critical' : 'warn',
        source: sourceMetrics.source,
        metric: 'success_rate',
        valuePct: sourceMetrics.successRatePct,
        thresholdPct: env.JOB_METRICS_ALERT_SUCCESS_RATE_MIN_PCT,
        message: `${sourceMetrics.source} success rate is ${sourceMetrics.successRatePct}% (minimum ${env.JOB_METRICS_ALERT_SUCCESS_RATE_MIN_PCT}%).`,
      });
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    window: metrics.window,
    thresholds: {
      minEvents,
      blockedRatePct: env.JOB_METRICS_ALERT_BLOCKED_RATE_PCT,
      browserFallbackRatePct: env.JOB_METRICS_ALERT_BROWSER_FALLBACK_RATE_PCT,
      successRateMinPct: env.JOB_METRICS_ALERT_SUCCESS_RATE_MIN_PCT,
    },
    hasAlerts: alerts.length > 0,
    alerts,
  };
}
