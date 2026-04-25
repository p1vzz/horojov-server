import assert from 'node:assert/strict';
import test from 'node:test';
import type { ChartPromptPayload } from './careerInsights.js';
import {
  buildMarketCareerContext,
  serializeMarketCareerPathsForPrompt,
} from './marketCareerContext.js';
import type { OccupationInsightResponse } from './marketData/types.js';

const chartPayload: ChartPromptPayload = {
  ascSign: 'Gemini',
  mcSign: 'Virgo',
  placements: [
    { planet: 'Mercury', sign: 'Virgo', house: 10, fullDegree: 150, retrograde: false },
    { planet: 'Saturn', sign: 'Capricorn', house: 6, fullDegree: 280, retrograde: false },
    { planet: 'Uranus', sign: 'Aquarius', house: 11, fullDegree: 310, retrograde: false },
  ],
  aspects: [],
};

function buildMarket(keyword: string, median: number): OccupationInsightResponse {
  return {
    query: {
      keyword,
      location: 'US',
    },
    occupation: {
      onetCode: '15-1252.00',
      socCode: '15-1252',
      title: keyword,
      description: null,
      matchConfidence: 'high',
    },
    salary: {
      currency: 'USD',
      period: 'annual',
      min: median - 20_000,
      max: median + 35_000,
      median,
      year: '2025',
      confidence: 'medium',
      basis: 'market_estimate',
    },
    outlook: {
      growthLabel: 'Much faster than average',
      projectedOpenings: 120_000,
      projectionYears: '2024-2034',
      demandLabel: 'high',
    },
    skills: [],
    labels: {
      marketScore: 'strong market',
      salaryVisibility: 'market_estimate',
    },
    sources: [
      {
        provider: 'careeronestop',
        label: 'CareerOneStop',
        url: 'https://www.careeronestop.org/',
        retrievedAt: '2026-04-23T00:00:00.000Z',
        attributionText: 'Labor market data provided by CareerOneStop, U.S. Department of Labor.',
        logoRequired: true,
      },
    ],
  };
}

test('market career context builds chart paths and free negotiation guidance', async () => {
  const context = await buildMarketCareerContext(
    {
      chartPayload,
      limit: 3,
    },
    {
      now: () => new Date('2026-04-23T12:00:00.000Z'),
      getOccupationInsight: async (request) => buildMarket(request.keyword, 125_000),
    },
  );

  assert.equal(context.algorithmVersion, 'market_career_context.v1');
  assert.equal(context.generatedAt, '2026-04-23T12:00:00.000Z');
  assert.equal(context.marketCareerPaths.length, 3);
  assert.ok(context.marketCareerPaths[0]!.salaryRangeLabel?.includes('/yr'));
  assert.equal(context.marketCareerPaths[0]!.marketGradient, 'high_upside');
  assert.equal(context.negotiationPrep.salaryVisibilityLabel, 'Market estimate');
  assert.equal(context.negotiationPrep.anchorStrategy.target, '$105k-$160k/yr');
  assert.match(context.negotiationPrep.summary, /public market estimate/);
  assert.ok(context.negotiationPrep.recruiterQuestions.length >= 4);
  assert.ok(context.negotiationPrep.salaryExpectationScripts.some((item) => item.label === 'When you have a market anchor'));
  assert.ok(context.negotiationPrep.offerChecklist.length >= 4);
  assert.ok(context.negotiationPrep.redFlags.length >= 3);
  assert.ok(context.negotiationPrep.tradeoffLevers.includes('Base salary'));

  const promptPaths = serializeMarketCareerPathsForPrompt(context.marketCareerPaths);
  assert.equal(promptPaths.length, 3);
  assert.equal(Object.hasOwn(promptPaths[0]!, 'market'), false);
});

test('market career context degrades when provider enrichment fails', async () => {
  const context = await buildMarketCareerContext(
    {
      chartPayload,
      limit: 2,
    },
    {
      getOccupationInsight: async () => {
        throw new Error('provider unavailable');
      },
    },
  );

  assert.equal(context.marketCareerPaths.length, 2);
  assert.equal(context.marketCareerPaths[0]!.market, null);
  assert.equal(context.marketCareerPaths[0]!.salaryRangeLabel, null);
  assert.equal(context.negotiationPrep.salaryRangeLabel, null);
});
