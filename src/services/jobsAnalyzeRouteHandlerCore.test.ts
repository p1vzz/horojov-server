import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCachedJobAnalyzeResponse } from './jobs/analyzeRouteHandler.js';

test('cached job analyze response keeps fresh-response preview fields', () => {
  const response = buildCachedJobAnalyzeResponse({
    analysisId: 'analysis-1',
    providerUsed: 'http_fetch',
    rawCacheHit: true,
    parsedCacheHit: true,
    plan: 'premium',
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
      description: 'Build product workflows.',
      employmentType: 'Full-time',
      datePosted: null,
      seniority: 'Senior',
    },
  });

  assert.equal(response.cached, true);
  assert.deepEqual(response.tags, ['product', 'remote']);
  assert.deepEqual(response.descriptors, ['leadership', 'communication']);
  assert.deepEqual(response.job, {
    title: 'Product Manager',
    company: 'Acme',
    location: 'Remote',
    employmentType: 'Full-time',
    source: 'linkedin',
  });
});
