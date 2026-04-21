import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FullNatalAnalysisGenerationError,
  generateFullNatalCareerAnalysis,
} from './fullNatalAnalysis.js';
import type { ChartPromptPayload } from './careerInsights.js';
import type { FullNatalCareerAnalysisPayloadDoc } from '../db/mongo.js';

const chartPayload: ChartPromptPayload = {
  ascSign: 'Virgo',
  mcSign: 'Gemini',
  placements: [
    {
      planet: 'Mercury',
      sign: 'Virgo',
      house: 10,
      fullDegree: 184.4,
      retrograde: false,
    },
    {
      planet: 'Sun',
      sign: 'Libra',
      house: 11,
      fullDegree: 198.2,
      retrograde: false,
    },
  ],
  aspects: [
    {
      from: 'Mercury',
      to: 'Saturn',
      type: 'trine',
      orb: 2.1,
    },
  ],
};

function buildValidLlmPayload(): FullNatalCareerAnalysisPayloadDoc {
  return {
    schemaVersion: 'custom.full_natal.v1',
    headline: 'Strategic Career Builder',
    executiveSummary:
      'Your chart points toward practical growth through structured decisions, visible ownership, and thoughtful collaboration. Use this report as a reflective planning tool rather than a fixed prediction.',
    careerArchetypes: [
      { name: 'Strategic Builder', score: 82, evidence: ['Mercury in Virgo, house 10', 'Sun in Libra, house 11'] },
      { name: 'Systems Translator', score: 78, evidence: ['Mercury-Saturn trine', 'Virgo emphasis supports practical detail'] },
      { name: 'Collaborative Operator', score: 74, evidence: ['Sun in Libra, house 11', 'Mercury in Virgo, house 10'] },
    ],
    strengths: [
      { title: 'Structured planning', details: 'You can turn complex goals into measurable work streams.', evidence: ['Mercury in Virgo, house 10'] },
      { title: 'Collaborative judgment', details: 'You tend to weigh context and relationship dynamics before committing.', evidence: ['Sun in Libra, house 11'] },
      { title: 'Practical communication', details: 'You can make detailed ideas easier for others to apply.', evidence: ['Mercury-Saturn trine'] },
      { title: 'Long-range consistency', details: 'Your strongest growth comes from repeatable systems and clear standards.', evidence: ['Mercury in Virgo, house 10'] },
    ],
    blindSpots: [
      { title: 'Over-refinement', risk: 'Polishing too long can slow visible progress.', mitigation: 'Set a clear shipping threshold before each project starts.', evidence: ['Mercury in Virgo, house 10'] },
      { title: 'Consensus drag', risk: 'Too much balancing can delay direct decisions.', mitigation: 'Name decision owners and deadlines early.', evidence: ['Sun in Libra, house 11'] },
      { title: 'Scope overload', risk: 'Taking every improvement path at once can dilute impact.', mitigation: 'Pick one primary growth vector per quarter.', evidence: ['Mercury-Saturn trine'] },
    ],
    roleFitMatrix: [
      { domain: 'Product Strategy', fitScore: 84, why: 'This path uses structured judgment and collaborative planning.', exampleRoles: ['Product Manager', 'Strategy Lead'] },
      { domain: 'Operations', fitScore: 81, why: 'This path rewards repeatable systems and practical execution.', exampleRoles: ['Operations Lead', 'Program Manager'] },
      { domain: 'Analytics', fitScore: 77, why: 'This path fits evidence-based problem solving and decision support.', exampleRoles: ['BI Analyst', 'Insights Manager'] },
      { domain: 'Consulting', fitScore: 75, why: 'This path uses diagnosis, framing, and stakeholder guidance.', exampleRoles: ['Consultant', 'Advisor'] },
      { domain: 'Team Leadership', fitScore: 73, why: 'This path fits structured support and clear accountability.', exampleRoles: ['Team Lead', 'Delivery Manager'] },
    ],
    phasePlan: [
      {
        phase: '0_6_months',
        goal: 'Clarify the strongest career direction and build a measurable execution rhythm.',
        actions: ['Define one primary role track.', 'Create a weekly progress review.', 'Ship one visible portfolio artifact.'],
        kpis: ['One role track selected', 'Weekly review completed'],
        risks: ['Too many parallel goals', 'Unclear decision criteria'],
      },
      {
        phase: '6_18_months',
        goal: 'Expand ownership through cross-functional work with visible outcomes.',
        actions: ['Lead one scoped initiative.', 'Document reusable operating principles.', 'Build stakeholder feedback loops.'],
        kpis: ['Initiative delivered', 'Stakeholder feedback collected'],
        risks: ['Overcommitment', 'Ambiguous ownership'],
      },
      {
        phase: '18_36_months',
        goal: 'Consolidate authority through a focused specialization and sustainable leadership habits.',
        actions: ['Choose a specialization lane.', 'Mentor one peer or teammate.', 'Publish lessons from completed work.'],
        kpis: ['Specialization selected', 'Mentorship cadence active'],
        risks: ['Identity lock-in', 'Delegation gaps'],
      },
    ],
    decisionRules: [
      'Choose role scope before title.',
      'Prefer clear ownership over broad visibility.',
      'Use written assumptions for major choices.',
      'Protect deep work before adding meetings.',
      'Review progress weekly with evidence.',
      'Trade speed for clarity when stakes rise.',
    ],
    next90DaysPlan: [
      'Write your target role direction in one paragraph.',
      'Build a weekly scoreboard with three indicators.',
      'Ship one practical artifact tied to the target role.',
      'Run two career conversations in your best-fit domain.',
      'Remove one low-leverage work stream from your week.',
      'Schedule a monthly decision retrospective.',
    ],
  };
}

test('full natal analysis returns only LLM output on success', async () => {
  const result = await generateFullNatalCareerAnalysis(
    { chartPayload },
    {
      isLlmAvailable: () => true,
      requestStructuredCompletion: async () => ({ parsedContent: buildValidLlmPayload() }),
    },
  );

  assert.equal(result.narrativeSource, 'llm');
  assert.equal(result.analysis.schemaVersion, 'full_natal_analysis.v1');
  assert.equal(result.analysis.roleFitMatrix.length, 5);
});

test('full natal analysis switches to backup provider when primary generation fails', async () => {
  const stages: string[] = [];
  const result = await generateFullNatalCareerAnalysis(
    {
      chartPayload,
      progress: {
        setStage: (stageKey) => stages.push(stageKey),
      },
    },
    {
      isLlmAvailable: () => true,
      isBackupLlmAvailable: () => true,
      backupModel: 'backup-model',
      requestStructuredCompletion: async () => {
        throw new Error('primary unavailable');
      },
      requestBackupStructuredCompletion: async () => ({ parsedContent: buildValidLlmPayload() }),
    },
  );

  assert.equal(result.narrativeSource, 'llm');
  assert.equal(result.model, 'backup-model');
  assert.deepEqual(stages, ['backup_route', 'validating_report']);
});

test('full natal analysis fails explicitly when primary and backup providers fail', async () => {
  await assert.rejects(
    () =>
      generateFullNatalCareerAnalysis(
        { chartPayload },
        {
          isLlmAvailable: () => true,
          isBackupLlmAvailable: () => true,
          backupModel: 'backup-model',
          requestStructuredCompletion: async () => {
            const error = new Error('primary rate limit');
            Object.assign(error, { upstreamStatus: 429, failureStage: 'upstream' });
            throw error;
          },
          requestBackupStructuredCompletion: async () => {
            throw new Error('backup transport failed');
          },
        },
      ),
    (error: unknown) =>
      error instanceof FullNatalAnalysisGenerationError &&
      error.code === 'full_natal_llm_upstream_error',
  );
});

test('full natal analysis fails explicitly when LLM pipeline is unavailable', async () => {
  await assert.rejects(
    () =>
      generateFullNatalCareerAnalysis(
        { chartPayload },
        {
          isLlmAvailable: () => false,
        },
      ),
    (error: unknown) =>
      error instanceof FullNatalAnalysisGenerationError &&
      error.code === 'full_natal_llm_unavailable',
  );
});

test('full natal analysis returns typed error when LLM request fails', async () => {
  const warnings: unknown[] = [];

  await assert.rejects(
    () =>
      generateFullNatalCareerAnalysis(
        {
          chartPayload,
          logger: {
            warn: (...args: unknown[]) => warnings.push(args),
          } as never,
        },
        {
          isLlmAvailable: () => true,
          requestStructuredCompletion: async () => {
            throw new Error('upstream unavailable');
          },
        },
      ),
    (error: unknown) => {
      assert.equal(warnings.length, 1);
      return (
        error instanceof FullNatalAnalysisGenerationError &&
        error.code === 'full_natal_llm_upstream_error'
      );
    },
  );
});

test('full natal analysis returns typed error when LLM payload is invalid', async () => {
  await assert.rejects(
    () =>
      generateFullNatalCareerAnalysis(
        { chartPayload },
        {
          isLlmAvailable: () => true,
          requestStructuredCompletion: async () => ({ parsedContent: { headline: 'Too sparse' } }),
        },
      ),
    (error: unknown) =>
      error instanceof FullNatalAnalysisGenerationError &&
      error.code === 'full_natal_llm_invalid_response',
  );
});

test('full natal analysis maps timeout-like LLM failures to timeout code', async () => {
  await assert.rejects(
    () =>
      generateFullNatalCareerAnalysis(
        { chartPayload },
        {
          isLlmAvailable: () => true,
          requestStructuredCompletion: async () => {
            const error = new Error('operation aborted due to timeout');
            error.name = 'TimeoutError';
            throw error;
          },
        },
      ),
    (error: unknown) =>
      error instanceof FullNatalAnalysisGenerationError &&
      error.code === 'full_natal_llm_timeout',
  );
});

test('full natal analysis maps upstream 429 to rate limit code', async () => {
  await assert.rejects(
    () =>
      generateFullNatalCareerAnalysis(
        { chartPayload },
        {
          isLlmAvailable: () => true,
          requestStructuredCompletion: async () => {
            const error = new Error('rate limit');
            Object.assign(error, { upstreamStatus: 429, failureStage: 'upstream' });
            throw error;
          },
        },
      ),
    (error: unknown) =>
      error instanceof FullNatalAnalysisGenerationError &&
      error.code === 'full_natal_llm_rate_limited',
  );
});

test('full natal generation lock shares concurrent producer work', async () => {
  const { serializeFullNatalAnalysisGeneration } = await import('./astrology/astrologyShared.js');
  let calls = 0;
  const producer = async () => {
    calls += 1;
    return {
      cached: false,
      model: 'model',
      promptVersion: 'v1',
      narrativeSource: 'llm' as const,
      generatedAt: '2026-04-20T10:00:00.000Z',
      profileUpdatedAt: '2026-04-20T09:00:00.000Z',
      profileChangeNotice: null,
      analysis: buildValidLlmPayload(),
    };
  };

  const [first, second] = await Promise.all([
    serializeFullNatalAnalysisGeneration('test-lock', producer),
    serializeFullNatalAnalysisGeneration('test-lock', producer),
  ]);

  assert.equal(calls, 1);
  assert.equal(first, second);
});

test('full natal profile change notice lasts for three days after changed profile data', async () => {
  const { resolveFullNatalProfileChangeNotice } = await import('./astrology/astrologyShared.js');
  const profileUpdatedAt = new Date('2026-04-20T10:00:00.000Z');
  const previousReport = {
    generatedAt: new Date('2026-04-19T10:00:00.000Z'),
  };

  assert.deepEqual(
    resolveFullNatalProfileChangeNotice({
      profileUpdatedAt,
      previousReport,
      now: new Date('2026-04-22T10:00:00.000Z'),
    }),
    {
      profileUpdatedAt: '2026-04-20T10:00:00.000Z',
      expiresAt: '2026-04-23T10:00:00.000Z',
    },
  );

  assert.equal(
    resolveFullNatalProfileChangeNotice({
      profileUpdatedAt,
      previousReport,
      now: new Date('2026-04-24T10:00:00.000Z'),
    }),
    null,
  );

  assert.equal(
    resolveFullNatalProfileChangeNotice({
      profileUpdatedAt,
      previousReport: {
        generatedAt: new Date('2026-04-20T11:00:00.000Z'),
      },
      now: new Date('2026-04-21T10:00:00.000Z'),
    }),
    null,
  );
});
