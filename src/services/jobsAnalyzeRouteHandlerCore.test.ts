import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCachedJobAnalyzeResponse } from './jobs/analyzeRouteHandler.js';

test('cached job analyze response keeps fresh-response preview fields', () => {
  const limit = {
    plan: 'premium' as const,
    depth: 'full' as const,
    period: 'daily_utc' as const,
    limit: 10,
    used: 2,
    remaining: 8,
    nextAvailableAt: null,
    canProceed: true,
  };
  const response = buildCachedJobAnalyzeResponse({
    analysisId: 'analysis-1',
    providerUsed: 'http_fetch',
    rawCacheHit: true,
    parsedCacheHit: true,
    plan: 'premium',
    limit,
    limits: {
      plan: 'premium',
      lite: { ...limit, depth: 'lite', limit: 30, used: 4, remaining: 26 },
      full: limit,
    },
    market: null,
    versions: {
      parserVersion: 'parser-v1',
      rubricVersion: 'rubric-v1',
      modelVersion: 'model-v1',
    },
    cachedResult: {
      scores: {
        compatibility: 82,
        aiReplacementRisk: 18,
        overall: 79,
      },
      breakdown: [{ key: 'role_fit', label: 'Role Fit', score: 80, note: 'Strong alignment' }],
      jobSummary: 'A product role with cross-team ownership.',
      tags: ['product', 'remote', 42],
    },
    parsedFeaturesObject: {
      descriptors: ['leadership', 'communication'],
    },
    normalizedJob: {
      source: 'linkedin',
      sourceJobId: '123',
      canonicalUrl: 'https://linkedin.com/jobs/view/123',
      title: 'Product Manager',
      company: 'Acme',
      location: 'Remote',
      salaryText: '$120,000-$150,000 per year',
      description: 'Build product workflows.',
      employmentType: 'Full-time',
      datePosted: null,
      seniority: 'Senior',
    },
  });

  assert.equal(response.cached, true);
  assert.equal(response.scanDepth, 'full');
  assert.equal(response.usage.depth, 'full');
  assert.deepEqual(response.usage.limit, limit);
  assert.deepEqual(response.tags, ['product', 'remote']);
  assert.deepEqual(response.descriptors, ['leadership', 'communication']);
  assert.deepEqual(response.job, {
    title: 'Product Manager',
    company: 'Acme',
    location: 'Remote',
    salaryText: '$120,000-$150,000 per year',
    employmentType: 'Full-time',
    source: 'linkedin',
  });
});
