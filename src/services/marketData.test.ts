import assert from 'node:assert/strict';
import test from 'node:test';
import { createCareerOneStopClient, type CareerOneStopOccupationResponse } from './marketData/careerOneStopClient.js';
import { createOnetClient } from './marketData/onetClient.js';
import { getOccupationInsight } from './marketData/occupationInsight.js';
import { MarketProviderError } from './marketData/providerErrors.js';
import type { MarketOccupationInsightDoc } from '../db/mongo.js';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const careerOneStopPayload: CareerOneStopOccupationResponse = {
  OccupationDetail: [
    {
      OnetTitle: 'Software Developers',
      OnetCode: '15-1252.00',
      OnetDescription: 'Research, design, and develop computer software.',
      Wages: {
        WageYear: '2024',
        NationalWagesList: [
          {
            RateType: 'Annual',
            Pct25: '103,000',
            Median: '133,080',
            Pct75: '161,480',
          },
        ],
      },
      BrightOutlook: 'Bright',
      BrightOutlookCategory: 'Rapid Growth; Numerous Job Openings',
      SocInfo: {
        SocCode: '151252',
        SocTitle: 'Software Developers',
        SocDescription: 'Develop and maintain software.',
      },
      Projections: {
        EstimatedYear: '2023',
        ProjectedYear: '2033',
        Projections: [
          {
            ProjectedAnnualJobOpening: '140,100',
            PerCentChange: '17.9',
          },
        ],
      },
      SkillsDataList: [
        { ElementName: 'Programming' },
        { ElementName: 'Critical Thinking' },
        { ElementName: 'Programming' },
      ],
    },
  ],
  RecordCount: 1,
  MetaData: {
    LastAccessDate: '2026-04-22T00:00:00.000Z',
    CitationSuggested: 'CareerOneStop citation.',
    DataSource: [
      {
        DataSourceUrl: 'https://www.careeronestop.org/',
      },
    ],
  },
};

class FakeMarketInsightCollection {
  docs = new Map<string, MarketOccupationInsightDoc>();
  findCalls = 0;
  updateCalls = 0;

  async findOne(filter: {
    cacheKey: string;
    expiresAt?: { $gt: Date };
  }): Promise<MarketOccupationInsightDoc | null> {
    this.findCalls += 1;
    const doc = this.docs.get(filter.cacheKey);
    if (!doc) return null;
    if (filter.expiresAt?.$gt && doc.expiresAt <= filter.expiresAt.$gt) {
      return null;
    }
    return doc;
  }

  async updateOne(
    filter: { cacheKey: string },
    update: {
      $set: Omit<MarketOccupationInsightDoc, '_id' | 'createdAt'>;
      $setOnInsert: Pick<MarketOccupationInsightDoc, '_id' | 'createdAt'>;
    },
    _options?: unknown,
  ) {
    this.updateCalls += 1;
    const existing = this.docs.get(filter.cacheKey);
    this.docs.set(filter.cacheKey, {
      ...update.$setOnInsert,
      ...existing,
      ...update.$set,
    });
    return {
      acknowledged: true,
      matchedCount: existing ? 1 : 0,
      modifiedCount: existing ? 1 : 0,
      upsertedCount: existing ? 0 : 1,
      upsertedId: existing ? null : update.$setOnInsert._id,
    };
  }
}

test('CareerOneStop client sends bearer credentials and market query flags', async () => {
  const captured: {
    requestUrl?: URL;
    requestHeaders?: Record<string, string>;
  } = {};
  const fetchFn: typeof fetch = async (input, init) => {
    captured.requestUrl = new URL(String(input));
    captured.requestHeaders = init?.headers as Record<string, string>;
    return jsonResponse({ OccupationDetail: [], RecordCount: 0 });
  };

  const client = createCareerOneStopClient({
    baseUrl: 'https://example.test',
    userId: 'user-id',
    token: 'token-value',
    timeoutMs: 1000,
    fetchFn,
  });
  await client.fetchOccupation({
    keyword: 'Software Developers',
    location: 'US',
  });

  assert.ok(captured.requestUrl);
  assert.ok(captured.requestHeaders);
  assert.equal(captured.requestUrl.pathname, '/v1/occupation/user-id/Software%20Developers/US');
  assert.equal(captured.requestUrl.searchParams.get('wages'), 'true');
  assert.equal(captured.requestUrl.searchParams.get('projectedEmployment'), 'true');
  assert.equal(captured.requestUrl.searchParams.get('skills'), 'true');
  assert.equal(captured.requestUrl.searchParams.get('enableMetaData'), 'true');
  assert.equal(captured.requestHeaders.Authorization, 'Bearer token-value');
});

test('CareerOneStop client maps upstream auth failures', async () => {
  const client = createCareerOneStopClient({
    baseUrl: 'https://example.test',
    userId: 'user-id',
    token: 'token-value',
    timeoutMs: 1000,
    fetchFn: async () => jsonResponse({ error: 'unauthorized' }, 401),
  });

  await assert.rejects(
    client.fetchOccupation({ keyword: 'Software Developers', location: 'US' }),
    (error) => error instanceof MarketProviderError && error.code === 'market_provider_unauthorized',
  );
});

test('O*NET client sends API key and keyword query', async () => {
  const captured: {
    requestUrl?: URL;
    requestHeaders?: Record<string, string>;
  } = {};
  const fetchFn: typeof fetch = async (input, init) => {
    captured.requestUrl = new URL(String(input));
    captured.requestHeaders = init?.headers as Record<string, string>;
    return jsonResponse({ occupation: [] });
  };

  const client = createOnetClient({
    baseUrl: 'https://example.test',
    apiKey: 'onet-key',
    timeoutMs: 1000,
    fetchFn,
  });
  await client.searchOccupations({ keyword: 'software developer' });

  assert.ok(captured.requestUrl);
  assert.ok(captured.requestHeaders);
  assert.equal(captured.requestUrl.pathname, '/online/search');
  assert.equal(captured.requestUrl.searchParams.get('keyword'), 'software developer');
  assert.equal(captured.requestHeaders['X-API-Key'], 'onet-key');
});

test('occupation insight normalizes market data and reuses fresh cache', async () => {
  const collection = new FakeMarketInsightCollection();
  let onetCalls = 0;
  let careerOneStopCalls = 0;
  let careerKeyword: string | null = null;
  const deps = {
    now: () => new Date('2026-04-22T12:00:00.000Z'),
    cacheTtlDays: 10,
    getCollections: async () => ({
      marketOccupationInsights: collection,
    }),
    onetClient: {
      searchOccupations: async () => {
        onetCalls += 1;
        return {
          occupation: [
            {
              code: '15-1252.00',
              title: 'Software Developers',
              href: 'https://www.onetonline.org/link/summary/15-1252.00',
              tags: { bright_outlook: true },
            },
          ],
        };
      },
    },
    careerOneStopClient: {
      fetchOccupation: async (input: { keyword: string; location: string }) => {
        careerOneStopCalls += 1;
        careerKeyword = input.keyword;
        return careerOneStopPayload;
      },
    },
  };

  const first = await getOccupationInsight(
    { keyword: ' software developer ', location: 'US' },
    deps,
  );
  const second = await getOccupationInsight(
    { keyword: 'software developer', location: 'US' },
    deps,
  );

  assert.equal(careerKeyword, '15-1252.00');
  assert.equal(first.occupation.title, 'Software Developers');
  assert.equal(first.occupation.matchConfidence, 'high');
  assert.equal(first.salary?.median, 133080);
  assert.equal(first.salary?.min, 103000);
  assert.equal(first.outlook.demandLabel, 'high');
  assert.equal(first.outlook.projectedOpenings, 140100);
  assert.equal(first.labels.marketScore, 'strong market');
  assert.equal(first.labels.salaryVisibility, 'market_estimate');
  assert.deepEqual(first.skills.map((skill) => skill.name), ['Programming', 'Critical Thinking']);
  assert.equal(first.sources[0]?.provider, 'careeronestop');
  assert.equal(first.sources[0]?.logoRequired, true);
  assert.equal(first.sources[1]?.provider, 'onet');
  assert.deepEqual(second, first);
  assert.equal(onetCalls, 1);
  assert.equal(careerOneStopCalls, 1);
  assert.equal(collection.findCalls, 2);
  assert.equal(collection.updateCalls, 1);
});

test('occupation insight reports no match when CareerOneStop has no detail', async () => {
  const collection = new FakeMarketInsightCollection();

  await assert.rejects(
    getOccupationInsight(
      { keyword: 'unknown role', location: 'US' },
      {
        now: () => new Date('2026-04-22T12:00:00.000Z'),
        getCollections: async () => ({
          marketOccupationInsights: collection,
        }),
        onetClient: {
          searchOccupations: async () => ({ occupation: [] }),
        },
        careerOneStopClient: {
          fetchOccupation: async () => ({
            OccupationDetail: [],
            RecordCount: 0,
          }),
        },
      },
    ),
    (error) => error instanceof MarketProviderError && error.code === 'market_no_match',
  );
});
