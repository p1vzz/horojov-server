import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeNarrativeFromLlm, shouldReuseCachedAiSynergy } from './aiSynergy.js';
import { normalizeInsightsPayload } from './careerInsights.js';
import { normalizeLlmPayload } from './fullNatalAnalysis.js';
import { normalizeInterviewStrategyExplanationFromLlm } from './interviewStrategy.js';
import { normalizeParsePayload } from './jobScreenshotParser.js';

function buildFullNatalGoldenPayload() {
  return {
    schemaVersion: ' custom.full_natal.v9 ',
    headline: ' Strategic Builder Blueprint ',
    executiveSummary:
      'This blueprint translates the chart into a practical career direction with clear sequencing, measurable priorities, and a sustainable growth path over the next three years.',
    careerArchetypes: [
      {
        name: ' Strategic Builder ',
        score: 118,
        evidence: [' Mercury in Virgo supports methodical execution ', ' Sun in 10th house favors visible ownership '],
      },
      {
        name: 'Systems Strategist',
        score: 84,
        evidence: [' Saturn aspect pattern rewards structure ', ' MC emphasis supports long-range planning '],
      },
      {
        name: 'Operational Leader',
        score: 79,
        evidence: [' Strong 6th house activity ', ' Practical earth-sign emphasis '],
      },
    ],
    strengths: Array.from({ length: 4 }, (_, index) => ({
      title: `Strength ${index + 1}`,
      details: `Detailed strength explanation ${index + 1} with enough narrative to survive the normalizer and preserve the intended meaning.`,
      evidence: [`Evidence ${index + 1}A`, `Evidence ${index + 1}B`],
    })),
    blindSpots: Array.from({ length: 3 }, (_, index) => ({
      title: `Blind Spot ${index + 1}`,
      risk: `Risk narrative ${index + 1} describing a realistic downside that appears under pressure or unclear role boundaries.`,
      mitigation: `Mitigation narrative ${index + 1} that adds a practical behavioral adjustment and review step.`,
      evidence: [`Blind evidence ${index + 1}`],
    })),
    roleFitMatrix: Array.from({ length: 5 }, (_, index) => ({
      domain: `Domain ${index + 1}`,
      fitScore: 65 + index * 6,
      why: `Role fit explanation ${index + 1} describing why the domain matches chart evidence and delivery style.`,
      exampleRoles: [`Role ${index + 1}A`, `Role ${index + 1}B`, `Role ${index + 1}C`],
    })),
    phasePlan: [
      {
        phase: '0_6_months',
        goal: 'Stabilize the immediate direction and create a repeatable execution rhythm.',
        actions: ['Action 1A', 'Action 1B', 'Action 1C'],
        kpis: ['KPI 1A', 'KPI 1B'],
        risks: ['Risk 1A', 'Risk 1B'],
      },
      {
        phase: '6_18_months',
        goal: 'Scale ownership into higher-leverage strategic scope.',
        actions: ['Action 2A', 'Action 2B', 'Action 2C'],
        kpis: ['KPI 2A', 'KPI 2B'],
        risks: ['Risk 2A', 'Risk 2B'],
      },
      {
        phase: '18_36_months',
        goal: 'Consolidate leadership advantage and long-term positioning.',
        actions: ['Action 3A', 'Action 3B', 'Action 3C'],
        kpis: ['KPI 3A', 'KPI 3B'],
        risks: ['Risk 3A', 'Risk 3B'],
      },
    ],
    decisionRules: Array.from({ length: 6 }, (_, index) => `Decision rule ${index + 1} with enough detail to remain valid.`),
    next90DaysPlan: Array.from({ length: 6 }, (_, index) => `Next 90 day action ${index + 1} with concrete execution wording.`),
  };
}

test('llm eval: screenshot parser golden payload normalizes and filters fields', () => {
  const normalized = normalizeParsePayload({
    status: 'ok',
    reason: '  Looks like a complete posting with readable details.  ',
    confidence: 1.4,
    sourceHint: 'linkedin',
    job: {
      title: ' Senior AI Product Manager ',
      company: ' Example Labs ',
      location: ' Remote, US ',
      employmentType: ' Full-time ',
      seniority: ' Senior ',
      description: '  Lead applied AI product strategy across consumer workflows.  ',
      highlights: [' Strong ownership ', '', 4, 'Prompt design and analytics'],
    },
    missingFields: ['location', 'mystery', 'description'],
  });

  assert.deepEqual(normalized, {
    status: 'ok',
    reason: 'Looks like a complete posting with readable details.',
    confidence: 1,
    sourceHint: 'linkedin',
    job: {
      title: 'Senior AI Product Manager',
      company: 'Example Labs',
      location: 'Remote, US',
      employmentType: 'Full-time',
      seniority: 'Senior',
      description: 'Lead applied AI product strategy across consumer workflows.',
      highlights: ['Strong ownership', 'Prompt design and analytics'],
    },
    missingFields: ['location', 'description'],
  });
});

test('llm eval: career insights normalizer keeps valid items and applies tier-specific action limits', () => {
  const premium = normalizeInsightsPayload('premium', {
    summary: '  Premium insight summary focused on leverage and risk calibration. ',
    insights: [
      {
        title: 'Strategic Leverage',
        tag: 'Leverage',
        description: 'Use the strongest chart factors to anchor high-impact work and protect deep execution windows.',
        actions: ['Own one roadmap decision', 'Publish a weekly decision memo', 'Trim low-leverage meetings', 'Ignore this extra action'],
      },
      {
        title: 'Communication Timing',
        tag: 'Timing',
        description: 'Key conversations land better when the messaging is structured and evidence-backed.',
        actions: ['Draft before meetings', 'Rank options explicitly', 'Summarize tradeoffs'],
      },
      {
        title: 'Blind Spot Watch',
        tag: 'Risk',
        description: 'Fast progress can hide weak assumptions, so use short review loops before committing to major changes.',
        actions: ['Write assumptions', 'Set a validation checkpoint', 'Request one external review'],
      },
      {
        title: 42,
      },
    ],
  });

  assert.equal(premium?.summary, 'Premium insight summary focused on leverage and risk calibration.');
  assert.equal(premium?.insights.length, 3);
  assert.deepEqual(premium?.insights[0]?.actions, [
    'Own one roadmap decision',
    'Publish a weekly decision memo',
    'Trim low-leverage meetings',
  ]);

  const free = normalizeInsightsPayload('free', {
    summary: ' Free tier summary ',
    insights: [
      {
        title: 'Focus',
        tag: 'Strength',
        description: 'Keep priorities narrow and visible so daily momentum stays usable.',
        actions: ['Choose one priority', 'Discard this extra action'],
      },
      {
        title: 'Communication',
        tag: 'Communication',
        description: 'Translate complex ideas into one direct next step before sharing them.',
        actions: ['Write a concise recap'],
      },
      {
        title: 'Growth',
        tag: 'Growth',
        description: 'Convert exploratory learning into one practical experiment each week.',
        actions: ['Ship a tiny experiment'],
      },
    ],
  });

  assert.deepEqual(
    free?.insights.map((item) => item.actions.length),
    [1, 1, 1]
  );
});

test('llm eval: interview strategy explanation normalizer rejects short copy and keeps polished copy', () => {
  assert.equal(
    normalizeInterviewStrategyExplanationFromLlm({
      explanation:
        '  Planetary currents are supportive here, giving you a calmer decision rhythm and clearer communication through the full interview window.  ',
    }),
    'Planetary currents are supportive here, giving you a calmer decision rhythm and clearer communication through the full interview window.'
  );
  assert.equal(normalizeInterviewStrategyExplanationFromLlm({ explanation: 'Too short to keep.' }), null);
  assert.equal(
    normalizeInterviewStrategyExplanationFromLlm({
      explanation:
        'Planetary currents rate this as an 88% interview window, giving you clear communication and calm delivery.',
    }),
    null
  );
});

test('llm eval: full natal analysis normalizer accepts golden payload and enforces structural limits', () => {
  const normalized = normalizeLlmPayload(buildFullNatalGoldenPayload());

  assert.ok(normalized);
  assert.equal(normalized.schemaVersion, 'custom.full_natal.v9');
  assert.equal(normalized.careerArchetypes[0]?.score, 100);
  assert.equal(normalized.strengths.length, 4);
  assert.equal(normalized.blindSpots.length, 3);
  assert.equal(normalized.roleFitMatrix.length, 5);
  assert.equal(normalized.phasePlan.length, 3);
  assert.equal(normalized.decisionRules.length, 6);
  assert.equal(normalized.next90DaysPlan.length, 6);
});

test('llm eval: full natal analysis normalizer rejects incomplete payloads', () => {
  const invalid = buildFullNatalGoldenPayload();
  invalid.phasePlan = invalid.phasePlan.slice(0, 2);

  assert.equal(normalizeLlmPayload(invalid), null);
});

test('llm eval: ai synergy narrative normalizer requires complete copy and three recommendations', () => {
  const normalized = normalizeNarrativeFromLlm({
    headline: ' Focused AI leverage window ',
    summary:
      ' Today favors structured AI collaboration when the workflow stays narrow, explicit, and tied to visible decisions. ',
    description:
      ' Use AI for synthesis-first drafting, but keep your own decision checkpoints tight. Short review loops and explicit ranking criteria will keep quality stable while speed rises across the day. ',
    recommendations: ['Lock one primary workflow', 'Keep a validation pass at the end', 'Translate output into decisions immediately', 'Ignore this extra item'],
  });

  assert.deepEqual(normalized, {
    headline: 'Focused AI leverage window',
    summary: 'Today favors structured AI collaboration when the workflow stays narrow, explicit, and tied to visible decisions.',
    description:
      'Use AI for synthesis-first drafting, but keep your own decision checkpoints tight. Short review loops and explicit ranking criteria will keep quality stable while speed rises across the day.',
    recommendations: [
      'Lock one primary workflow',
      'Keep a validation pass at the end',
      'Translate output into decisions immediately',
    ],
  });

  assert.equal(
    normalizeNarrativeFromLlm({
      headline: 'Bad',
      summary: 'Too short',
      description: 'Still too short',
      recommendations: ['Only one'],
    }),
    null
  );
});

test('llm eval: ai synergy pending cache is treated as unfinished', () => {
  assert.equal(shouldReuseCachedAiSynergy({ narrativeStatus: 'ready' }), true);
  assert.equal(shouldReuseCachedAiSynergy({ narrativeStatus: 'failed' }), true);
  assert.equal(shouldReuseCachedAiSynergy({ narrativeStatus: 'unavailable' }), true);
  assert.equal(shouldReuseCachedAiSynergy({ narrativeStatus: 'pending' }), false);
});
