import { createHash } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { env } from '../../config/env.js';
import {
  getCollections,
  type MarketOccupationInsightDoc,
} from '../../db/mongo.js';
import {
  createCareerOneStopClient,
  type CareerOneStopOccupationDetail,
  type CareerOneStopOccupationResponse,
  type CareerOneStopWageEntry,
} from './careerOneStopClient.js';
import {
  createOnetClient,
  type OnetSearchOccupation,
  type OnetSearchResponse,
} from './onetClient.js';
import { MarketProviderError } from './providerErrors.js';
import type {
  MarketSalaryRange,
  MarketSkillCategory,
  OccupationInsightRequest,
  OccupationInsightResponse,
} from './types.js';

type CareerOneStopClient = ReturnType<typeof createCareerOneStopClient>;
type OnetClient = ReturnType<typeof createOnetClient>;
type MarketInsightCollection = {
  findOne: (filter: {
    cacheKey: string;
    expiresAt?: { $gt: Date };
  }) => Promise<MarketOccupationInsightDoc | null>;
  updateOne: (
    filter: { cacheKey: string },
    update: {
      $set: Omit<MarketOccupationInsightDoc, '_id' | 'createdAt'>;
      $setOnInsert: Pick<MarketOccupationInsightDoc, '_id' | 'createdAt'>;
    },
    options: { upsert: true },
  ) => Promise<unknown>;
};

export type OccupationInsightDependencies = {
  careerOneStopClient?: CareerOneStopClient;
  onetClient?: OnetClient;
  getCollections?: () => Promise<{
    marketOccupationInsights: MarketInsightCollection;
  }>;
  now?: () => Date;
  cacheTtlDays?: number;
};

const DEFAULT_LOCATION = 'US';
const MAX_SKILLS = 16;

export async function getOccupationInsight(
  request: OccupationInsightRequest,
  deps: OccupationInsightDependencies = {},
): Promise<OccupationInsightResponse> {
  const keyword = normalizeHumanInput(request.keyword);
  const location = normalizeHumanInput(request.location || DEFAULT_LOCATION);
  const normalizedKeyword = normalizeCacheTerm(keyword);
  const normalizedLocation = normalizeCacheTerm(location);
  const cacheKey = buildCacheKey(normalizedKeyword, normalizedLocation);
  const now = deps.now?.() ?? new Date();
  const collection = await (deps.getCollections ?? getCollections)().then(
    (collections) => collections.marketOccupationInsights,
  );

  if (!request.refresh) {
    const cached = await collection.findOne({
      cacheKey,
      expiresAt: { $gt: now },
    });
    if (cached) return docToResponse(cached);
  }

  const careerOneStopClient = deps.careerOneStopClient ?? createCareerOneStopClient();
  const onetClient = deps.onetClient ?? createOnetClient();
  const onetMatch = await findBestOnetMatch(onetClient, keyword);
  const careerKeyword = onetMatch?.code ?? keyword;
  const careerOneStopPayload = await careerOneStopClient.fetchOccupation({
    keyword: careerKeyword,
    location,
  });
  const insight = normalizeCareerOneStopPayload({
    payload: careerOneStopPayload,
    keyword,
    location,
    onetMatch,
    retrievedAt: now,
  });
  const expiresAt = new Date(
    now.getTime() + (deps.cacheTtlDays ?? env.MARKET_CACHE_TTL_DAYS) * 24 * 60 * 60 * 1000,
  );
  const doc: Omit<MarketOccupationInsightDoc, '_id' | 'createdAt'> = {
    cacheKey,
    keyword,
    normalizedKeyword,
    location,
    normalizedLocation,
    occupation: insight.occupation,
    salary: insight.salary,
    outlook: insight.outlook,
    skills: insight.skills,
    labels: insight.labels,
    sources: insight.sources,
    retrievedAt: now,
    expiresAt,
    updatedAt: now,
  };

  await collection.updateOne(
    { cacheKey },
    {
      $set: doc,
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true },
  );

  return insight;
}

export function buildCacheKey(normalizedKeyword: string, normalizedLocation: string) {
  const hash = createHash('sha256')
    .update(`occupation-insight:v1:${normalizedKeyword}:${normalizedLocation}`)
    .digest('hex')
    .slice(0, 32);
  return `occupation-insight:v1:${hash}`;
}

export function normalizeCareerOneStopPayload(input: {
  payload: CareerOneStopOccupationResponse;
  keyword: string;
  location: string;
  onetMatch: OnetSearchOccupation | null;
  retrievedAt: Date;
}): OccupationInsightResponse {
  const detail = pickOccupationDetail(input.payload);
  if (!detail) {
    throw new MarketProviderError(
      'market_no_match',
      'No matching occupation found in CareerOneStop',
      404,
      input.payload,
    );
  }

  const salary = buildSalary(detail);
  const outlook = buildOutlook(detail);
  const occupationTitle =
    cleanString(detail.OnetTitle) ??
    cleanString(detail.SocInfo?.SocTitle) ??
    cleanString(input.onetMatch?.title) ??
    input.keyword;
  const onetCode = cleanString(detail.OnetCode) ?? cleanString(input.onetMatch?.code);
  const socCode = cleanString(detail.SocInfo?.SocCode) ?? cleanString(detail.Wages?.SocWageInfo?.SocCode);

  const result: OccupationInsightResponse = {
    query: {
      keyword: input.keyword,
      location: input.location,
    },
    occupation: {
      onetCode,
      socCode,
      title: occupationTitle,
      description:
        cleanString(detail.OnetDescription) ??
        cleanString(detail.SocInfo?.SocDescription) ??
        cleanString(detail.Wages?.SocWageInfo?.SocDescription),
      matchConfidence: resolveMatchConfidence({
        detail,
        onetMatch: input.onetMatch,
        keyword: input.keyword,
      }),
    },
    salary,
    outlook,
    skills: buildSkills(detail),
    labels: {
      marketScore: buildMarketScore(outlook.demandLabel, salary),
      salaryVisibility: salary ? 'market_estimate' : 'unavailable',
    },
    sources: buildSources({
      metadata: input.payload.MetaData,
      onetMatch: input.onetMatch,
      retrievedAt: input.retrievedAt,
    }),
  };

  return result;
}

function docToResponse(doc: MarketOccupationInsightDoc): OccupationInsightResponse {
  return {
    query: {
      keyword: doc.keyword,
      location: doc.location,
    },
    occupation: doc.occupation,
    salary: doc.salary,
    outlook: doc.outlook,
    skills: doc.skills,
    labels: doc.labels,
    sources: doc.sources,
  };
}

async function findBestOnetMatch(
  onetClient: OnetClient,
  keyword: string,
): Promise<OnetSearchOccupation | null> {
  try {
    const search = await onetClient.searchOccupations({ keyword });
    return pickOnetOccupation(search, keyword);
  } catch (error) {
    if (error instanceof MarketProviderError) {
      return null;
    }
    throw error;
  }
}

function pickOnetOccupation(search: OnetSearchResponse, keyword: string): OnetSearchOccupation | null {
  const occupations = Array.isArray(search.occupation) ? search.occupation : [];
  if (occupations.length === 0) return null;
  const normalizedKeyword = normalizeCacheTerm(keyword);
  const exactTitle = occupations.find((occupation) => normalizeCacheTerm(occupation.title ?? '') === normalizedKeyword);
  return exactTitle ?? occupations[0] ?? null;
}

function pickOccupationDetail(payload: CareerOneStopOccupationResponse): CareerOneStopOccupationDetail | null {
  const details = Array.isArray(payload.OccupationDetail)
    ? payload.OccupationDetail
    : payload.OccupationDetail
      ? [payload.OccupationDetail]
      : [];
  return details.find(Boolean) ?? null;
}

function buildSalary(detail: CareerOneStopOccupationDetail): MarketSalaryRange | null {
  const wages = detail.Wages;
  if (!wages) return null;
  const candidates: Array<{
    entry: CareerOneStopWageEntry;
    confidence: MarketSalaryRange['confidence'];
  }> = [
    ...collectWageEntries(wages.NationalWagesList, 'high'),
    ...collectWageEntries(wages.StateWagesList, 'medium'),
    ...collectWageEntries(wages.BLSAreaWagesList, 'medium'),
  ];
  const selected = candidates.find(({ entry }) => isAnnualWage(entry)) ?? candidates[0];
  if (!selected) return null;

  const min = parseNumber(selected.entry.Pct25 ?? selected.entry.Pct10);
  const max = parseNumber(selected.entry.Pct75 ?? selected.entry.Pct90);
  const median = parseNumber(selected.entry.Median);
  if (min === null && max === null && median === null) return null;

  return {
    currency: 'USD',
    period: isAnnualWage(selected.entry) ? 'annual' : 'hourly',
    min,
    max,
    median,
    year: cleanString(wages.WageYear) ?? null,
    confidence: selected.confidence,
    basis: 'market_estimate',
  };
}

function collectWageEntries(
  entries: CareerOneStopWageEntry[] | undefined,
  confidence: MarketSalaryRange['confidence'],
) {
  return (Array.isArray(entries) ? entries : []).map((entry) => ({
    entry,
    confidence,
  }));
}

function isAnnualWage(entry: CareerOneStopWageEntry) {
  return (entry.RateType ?? '').toLowerCase().includes('annual');
}

function buildOutlook(detail: CareerOneStopOccupationDetail): OccupationInsightResponse['outlook'] {
  const projectionRows = Array.isArray(detail.Projections?.Projections)
    ? detail.Projections.Projections
    : [];
  const projection = projectionRows[0] ?? null;
  const projectedOpenings = parseNumber(projection?.ProjectedAnnualJobOpening);
  const percentChange = parseNumber(projection?.PerCentChange);
  const estimatedYear = cleanString(projection?.EstimatedYear) ?? cleanString(detail.Projections?.EstimatedYear);
  const projectedYear = cleanString(projection?.ProjectedYear) ?? cleanString(detail.Projections?.ProjectedYear);
  const projectionYears = estimatedYear && projectedYear ? `${estimatedYear}-${projectedYear}` : null;
  const growthLabel = cleanString(detail.BrightOutlookCategory) ?? cleanString(detail.BrightOutlook);

  return {
    growthLabel,
    projectedOpenings,
    projectionYears,
    demandLabel: buildDemandLabel({
      brightOutlook: detail.BrightOutlook,
      growthLabel,
      projectedOpenings,
      percentChange,
    }),
  };
}

function buildDemandLabel(input: {
  brightOutlook?: string | null;
  growthLabel: string | null;
  projectedOpenings: number | null;
  percentChange: number | null;
}): OccupationInsightResponse['outlook']['demandLabel'] {
  const brightText = `${input.brightOutlook ?? ''} ${input.growthLabel ?? ''}`.toLowerCase();
  const clearlyNotBright = brightText.includes('not bright');
  const isBright =
    !clearlyNotBright &&
    (brightText.includes('bright') ||
      brightText.includes('rapid') ||
      brightText.includes('numerous') ||
      brightText.includes('new & emerging'));

  if (isBright || (input.percentChange !== null && input.percentChange >= 8)) return 'high';
  if (input.projectedOpenings !== null && input.projectedOpenings >= 10_000) return 'high';
  if (input.percentChange !== null && input.percentChange < 0) return 'low';
  if (input.percentChange !== null || (input.projectedOpenings !== null && input.projectedOpenings > 0)) {
    return 'moderate';
  }
  return 'unknown';
}

function buildSkills(detail: CareerOneStopOccupationDetail): OccupationInsightResponse['skills'] {
  const skills = Array.isArray(detail.SkillsDataList) ? detail.SkillsDataList : [];
  const seen = new Set<string>();
  const result: OccupationInsightResponse['skills'] = [];

  for (const skill of skills) {
    const name = cleanString(skill.ElementName);
    if (!name) continue;
    const key = normalizeCacheTerm(name);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      name,
      category: categorizeSkill(name),
      sourceProvider: 'careeronestop',
    });
    if (result.length >= MAX_SKILLS) break;
  }

  return result;
}

function categorizeSkill(name: string): MarketSkillCategory {
  const normalized = name.toLowerCase();
  if (normalized.includes('knowledge')) return 'knowledge';
  if (normalized.includes('tool')) return 'tool';
  if (normalized.includes('technology')) return 'technology';
  if (normalized.includes('ability')) return 'ability';
  return 'skill';
}

function buildMarketScore(
  demandLabel: OccupationInsightResponse['outlook']['demandLabel'],
  salary: MarketSalaryRange | null,
): OccupationInsightResponse['labels']['marketScore'] {
  if (demandLabel === 'high' && salary) return 'strong market';
  if (demandLabel === 'high' || (demandLabel === 'moderate' && salary)) return 'steady market';
  if (demandLabel === 'moderate') return 'niche market';
  return 'limited data';
}

function buildSources(input: {
  metadata: CareerOneStopOccupationResponse['MetaData'];
  onetMatch: OnetSearchOccupation | null;
  retrievedAt: Date;
}): OccupationInsightResponse['sources'] {
  const retrievedAt =
    parseSourceDate(input.metadata?.LastAccessDate)?.toISOString() ??
    input.retrievedAt.toISOString();
  const careerOneStopDataSource = input.metadata?.DataSource?.find((source) => source.DataSourceUrl);
  const sources: OccupationInsightResponse['sources'] = [
    {
      provider: 'careeronestop',
      label: 'CareerOneStop',
      url: cleanString(careerOneStopDataSource?.DataSourceUrl) ?? 'https://www.careeronestop.org/',
      retrievedAt,
      attributionText:
        cleanString(input.metadata?.CitationSuggested) ??
        'Labor market data provided by CareerOneStop, U.S. Department of Labor.',
      logoRequired: true,
    },
  ];

  if (input.onetMatch) {
    sources.push({
      provider: 'onet',
      label: 'O*NET OnLine',
      url: cleanString(input.onetMatch.href) ?? 'https://www.onetonline.org/',
      retrievedAt: input.retrievedAt.toISOString(),
      attributionText:
        'Occupation matching data provided by O*NET OnLine, National Center for O*NET Development.',
      logoRequired: false,
    });
  }

  return sources;
}

function resolveMatchConfidence(input: {
  detail: CareerOneStopOccupationDetail;
  onetMatch: OnetSearchOccupation | null;
  keyword: string;
}): OccupationInsightResponse['occupation']['matchConfidence'] {
  const detailCode = cleanString(input.detail.OnetCode);
  const onetCode = cleanString(input.onetMatch?.code);
  if (detailCode && onetCode && detailCode === onetCode) return 'high';

  const detailTitle = normalizeCacheTerm(input.detail.OnetTitle ?? '');
  const onetTitle = normalizeCacheTerm(input.onetMatch?.title ?? '');
  const keyword = normalizeCacheTerm(input.keyword);
  if (detailTitle && (detailTitle === onetTitle || detailTitle === keyword)) return 'high';
  if (detailCode || detailTitle) return 'medium';
  return 'low';
}

function parseSourceDate(value?: string) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  const parsed = new Date(cleaned);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseNumber(value?: string | number | null) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/[^\d.-]/g, '');
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value?: string | null) {
  if (typeof value !== 'string') return null;
  const cleaned = normalizeHumanInput(value);
  return cleaned.length > 0 ? cleaned : null;
}

function normalizeHumanInput(input: string) {
  return input.trim().replace(/\s+/g, ' ');
}

function normalizeCacheTerm(input: string) {
  return normalizeHumanInput(input).toLowerCase();
}
