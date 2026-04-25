import type { FastifyBaseLogger } from 'fastify';
import type { NormalizedJobPayload } from '../jobProviders.js';
import {
  getOccupationInsight,
} from '../marketData/occupationInsight.js';
import { MarketProviderError } from '../marketData/providerErrors.js';
import type { OccupationInsightResponse } from '../marketData/types.js';

export async function buildJobMarketInsight(input: {
  normalizedJob: NormalizedJobPayload;
  log?: FastifyBaseLogger;
}): Promise<OccupationInsightResponse | null> {
  const keyword = input.normalizedJob.title.trim();
  if (keyword.length < 2) return null;

  try {
    return await getOccupationInsight({
      keyword,
      location: 'US',
    });
  } catch (error) {
    if (error instanceof MarketProviderError) {
      input.log?.warn(
        {
          code: error.code,
          upstreamStatus: error.status,
          jobTitle: keyword,
        },
        'Job market enrichment unavailable',
      );
      return null;
    }

    input.log?.warn({ error, jobTitle: keyword }, 'Job market enrichment failed');
    return null;
  }
}
