import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDiscoverRoleDecisionSupport,
  computeDiscoverRoleMarketOpportunityScore,
  computeDiscoverRoleOpportunityRankScore,
  findBestDiscoverRoleCatalogMatch,
} from './discoverRoles.js';
import type { DiscoverRoleCatalogDoc } from '../db/mongo.js';
import type { OccupationInsightResponse } from './marketData/types.js';
import type { DiscoverRoleCurrentJobPayload } from './astrology/discoverRoleCurrentJobStore.js';

function market(overrides: Partial<OccupationInsightResponse> = {}): OccupationInsightResponse {
  return {
    query: {
      keyword: 'software developer',
      location: 'US',
    },
    occupation: {
      onetCode: '15-1252.00',
      socCode: '151252',
      title: 'Software Developers',
      description: null,
      matchConfidence: 'high',
    },
    salary: {
      currency: 'USD',
      period: 'annual',
      min: 100_000,
      max: 160_000,
      median: 135_000,
      year: '2024',
      confidence: 'high',
      basis: 'market_estimate',
    },
    outlook: {
      growthLabel: 'Bright outlook',
      projectedOpenings: 140_000,
      projectionYears: '2023-2033',
      demandLabel: 'high',
    },
    skills: [],
    labels: {
      marketScore: 'strong market',
      salaryVisibility: 'market_estimate',
    },
    sources: [],
    ...overrides,
  };
}

function role(overrides: Partial<DiscoverRoleCatalogDoc> & Pick<DiscoverRoleCatalogDoc, 'slug' | 'title' | 'domain'>): DiscoverRoleCatalogDoc {
  return {
    _id: null as never,
    slug: overrides.slug,
    title: overrides.title,
    domain: overrides.domain,
    majorGroup: overrides.majorGroup ?? '15',
    onetCode: overrides.onetCode ?? null,
    source: overrides.source ?? 'manual',
    sourceUrl: overrides.sourceUrl ?? null,
    aliases: overrides.aliases ?? [],
    keywords: overrides.keywords ?? overrides.title.toLowerCase().split(/\s+/),
    tags: overrides.tags ?? [],
    traitWeights: overrides.traitWeights ?? {
      analytical: 0.5,
      creative: 0.3,
      leadership: 0.4,
      technical: 0.4,
      people: 0.3,
      business: 0.4,
      operations: 0.4,
      detail: 0.4,
      research: 0.3,
      communication: 0.4,
    },
    active: true,
    createdAt: new Date('2026-04-24T00:00:00.000Z'),
    updatedAt: new Date('2026-04-24T00:00:00.000Z'),
  };
}

test('discover role market opportunity score rewards salary, demand and openings', () => {
  const strong = computeDiscoverRoleMarketOpportunityScore(market());
  const limited = computeDiscoverRoleMarketOpportunityScore(
    market({
      salary: null,
      outlook: {
        growthLabel: null,
        projectedOpenings: null,
        projectionYears: null,
        demandLabel: 'unknown',
      },
      labels: {
        marketScore: 'limited data',
        salaryVisibility: 'unavailable',
      },
    }),
  );

  assert.ok(strong > limited);
  assert.equal(strong, 96);
  assert.equal(limited, 24);
});

test('discover role opportunity rank blends market context with personal fit', () => {
  const highOpportunity = computeDiscoverRoleOpportunityRankScore({
    fitScore: 78,
    market: market(),
  });
  const highFitLimitedMarket = computeDiscoverRoleOpportunityRankScore({
    fitScore: 92,
    market: market({
      salary: null,
      outlook: {
        growthLabel: null,
        projectedOpenings: null,
        projectionYears: null,
        demandLabel: 'unknown',
      },
      labels: {
        marketScore: 'limited data',
        salaryVisibility: 'unavailable',
      },
    }),
  });

  assert.ok(highOpportunity > highFitLimitedMarket);
});

test('discover role catalog matching prefers exact and alias-friendly titles for current job normalization', () => {
  const roles: DiscoverRoleCatalogDoc[] = [
    role({
      slug: 'software-developers',
      title: 'Software Developers',
      domain: 'Data & Technology',
      onetCode: '15-1252.00',
      source: 'onetonline',
      sourceUrl: 'https://www.onetonline.org/link/summary/15-1252.00',
      keywords: ['software', 'developers'],
      tags: ['Technical'],
      traitWeights: {
        analytical: 0.8,
        creative: 0.2,
        leadership: 0.2,
        technical: 0.9,
        people: 0.1,
        business: 0.2,
        operations: 0.2,
        detail: 0.5,
        research: 0.4,
        communication: 0.3,
      },
    }),
    role({
      slug: 'product-manager',
      title: 'Product Manager',
      domain: 'Product & Strategy',
      majorGroup: '11',
      aliases: ['Product Owner', 'Technical Product Manager'],
      keywords: ['product', 'manager', 'owner'],
      tags: ['Strategic'],
      traitWeights: {
        analytical: 0.6,
        creative: 0.3,
        leadership: 0.7,
        technical: 0.4,
        people: 0.4,
        business: 0.8,
        operations: 0.6,
        detail: 0.4,
        research: 0.3,
        communication: 0.7,
      },
    }),
  ];

  assert.equal(findBestDiscoverRoleCatalogMatch(roles, 'product owner')?.slug, 'product-manager');
  assert.equal(findBestDiscoverRoleCatalogMatch(roles, 'software developers')?.slug, 'software-developers');
  assert.equal(findBestDiscoverRoleCatalogMatch(roles, 'x')?.slug ?? null, null);
});

test('discover role decision support prefers current-lane alternatives and bounded transition paths', () => {
  const selectedRole = role({
    slug: 'software-developers',
    title: 'Software Developers',
    domain: 'Data & Technology',
    tags: ['Technical', 'Builder'],
  });
  const productManager = role({
    slug: 'product-manager',
    title: 'Product Manager',
    domain: 'Product & Strategy',
    tags: ['Strategic', 'Leadership'],
  });
  const projectCoordinator = role({
    slug: 'project-coordinator',
    title: 'Project Coordinator',
    domain: 'Product & Strategy',
    tags: ['Operational', 'Strategic'],
  });
  const solutionsArchitect = role({
    slug: 'solutions-architect',
    title: 'Solutions Architect',
    domain: 'Data & Technology',
    tags: ['Technical', 'Strategic'],
  });
  const rankedRoles = [
    { role: selectedRole, score: 88 },
    { role: productManager, score: 84 },
    { role: projectCoordinator, score: 78 },
    { role: solutionsArchitect, score: 82 },
  ];
  const currentJob: DiscoverRoleCurrentJobPayload = {
    title: 'Product Manager',
    matchedRole: {
      slug: 'product-manager',
      title: 'Product Manager',
      domain: 'Product & Strategy',
      source: {
        provider: 'manual',
        code: null,
        url: null,
      },
    },
    updatedAt: '2026-04-24T00:00:00.000Z',
  };

  const support = buildDiscoverRoleDecisionSupport({
    selectedRole,
    selectedScore: 88,
    rankedRoles,
    currentJob,
  });

  assert.equal(support.bestAlternative?.role.slug, 'product-manager');
  assert.match(support.bestAlternative?.headline ?? '', /current role|current lane/i);
  assert.ok(support.transitionMap.length >= 2);
  assert.ok(support.transitionMap.length <= 3);
  assert.equal(support.transitionMap.some((item) => item.role.slug === selectedRole.slug), false);
  assert.equal(support.transitionMap[0]?.label, 'Closest Next Move');
});
