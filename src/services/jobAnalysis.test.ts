import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDeterministicJobAnalysis, extractJobFeatures } from './jobAnalysis.js';
import type { NormalizedJobPayload } from './jobProviders.js';

const jobFixture: NormalizedJobPayload = {
  source: 'linkedin',
  sourceJobId: '123456789',
  canonicalUrl: 'https://www.linkedin.com/jobs/view/123456789',
  title: 'Senior Product Analytics Manager',
  company: 'Acme Labs',
  location: 'Warsaw, Poland',
  description:
    'Lead analytics roadmap, build SQL dashboards, partner with product and engineering, communicate insights to stakeholders, and drive long-term strategy under fast-paced deadlines.',
  employmentType: 'full-time',
  datePosted: '2026-03-17T00:00:00.000Z',
  seniority: 'senior',
};

const natalChartFixture = {
  houses: [
    {
      house_id: 1,
      planets: [{ name: 'Sun' }],
    },
    {
      house_id: 6,
      planets: [{ name: 'Mars' }],
    },
    {
      house_id: 10,
      planets: [{ name: 'Mercury' }, { name: 'Jupiter' }],
    },
    {
      house_id: 11,
      planets: [{ name: 'Moon' }],
    },
  ],
};

test('deterministic job analysis is stable for same input payload', () => {
  const features = extractJobFeatures(jobFixture);
  const runs = Array.from({ length: 5 }, () =>
    buildDeterministicJobAnalysis({
      normalizedJob: jobFixture,
      features,
      natalChart: natalChartFixture,
    })
  );

  for (let index = 1; index < runs.length; index += 1) {
    assert.deepEqual(runs[index], runs[0]);
  }
});

test('deterministic analysis outputs bounded score fields and full breakdown schema', () => {
  const features = extractJobFeatures(jobFixture);
  const result = buildDeterministicJobAnalysis({
    normalizedJob: jobFixture,
    features,
    natalChart: natalChartFixture,
  });

  const inRange = (value: number) => Number.isFinite(value) && value >= 0 && value <= 100;
  assert.equal(inRange(result.scores.compatibility), true);
  assert.equal(inRange(result.scores.aiReplacementRisk), true);
  assert.equal(inRange(result.scores.overall), true);

  assert.equal(result.breakdown.length, 4);
  assert.deepEqual(
    result.breakdown.map((item) => item.key),
    ['role_fit', 'growth_potential', 'stress_load', 'ai_resilience']
  );
});
