import { env } from '../config/env.js';
import { openAiStructuredGateway } from './llmGateway.js';
import { getFullNatalAnalysisPromptConfig } from './llmPromptRegistry.js';
import type { ChartPromptPayload } from './careerInsights.js';
import type {
  FullNatalCareerAnalysisPayloadDoc,
  FullNatalCareerArchetypeDoc,
  FullNatalCareerBlindSpotDoc,
  FullNatalCareerPhasePlanDoc,
  FullNatalCareerRoleFitDoc,
  FullNatalCareerStrengthDoc,
} from '../db/mongo.js';

type FullNatalContextInput = {
  aiSynergyScore?: number | null;
  aiSynergyBand?: 'peak' | 'strong' | 'stable' | 'volatile' | null;
  careerInsightsSummary?: string | null;
};

const FULL_NATAL_SCHEMA_VERSION = 'full_natal_analysis.v1';

const FULL_NATAL_SYSTEM_PROMPT = [
  'You are a senior vocational astrologer and career strategy advisor.',
  'Your task is to produce a practical long-range career blueprint.',
  'Use only the provided input data and evidence.',
  'No deterministic predictions and no guaranteed outcomes.',
  'Avoid medical, legal, and financial claims.',
  'Every key recommendation should reference chart evidence in plain language.',
  'Output strict JSON only, matching schema.',
].join(' ');

const FULL_NATAL_USER_PROMPT = [
  'Generate Full Natal Career Blueprint.',
  'Requirements:',
  '- executiveSummary: 2-4 focused sentences.',
  '- careerArchetypes: 3 to 4 entries with score 0..100 and clear evidence lines.',
  '- strengths: exactly 4 entries.',
  '- blindSpots: exactly 3 entries with mitigation.',
  '- roleFitMatrix: exactly 5 domains with fitScore and example roles.',
  '- phasePlan: exactly 3 phases (0_6_months, 6_18_months, 18_36_months).',
  '- decisionRules: exactly 6 concise rules.',
  '- next90DaysPlan: exactly 6 concrete actions.',
  '- Tone: strategic, practical, not mystical.',
].join('\n');

const OUTPUT_SCHEMA = {
  name: 'full_natal_career_blueprint',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'schemaVersion',
      'headline',
      'executiveSummary',
      'careerArchetypes',
      'strengths',
      'blindSpots',
      'roleFitMatrix',
      'phasePlan',
      'decisionRules',
      'next90DaysPlan',
    ],
    properties: {
      schemaVersion: { type: 'string', minLength: 3, maxLength: 80 },
      headline: { type: 'string', minLength: 6, maxLength: 120 },
      executiveSummary: { type: 'string', minLength: 80, maxLength: 800 },
      careerArchetypes: {
        type: 'array',
        minItems: 3,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'score', 'evidence'],
          properties: {
            name: { type: 'string', minLength: 3, maxLength: 80 },
            score: { type: 'number', minimum: 0, maximum: 100 },
            evidence: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 8, maxLength: 180 },
            },
          },
        },
      },
      strengths: {
        type: 'array',
        minItems: 4,
        maxItems: 4,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'details', 'evidence'],
          properties: {
            title: { type: 'string', minLength: 3, maxLength: 100 },
            details: { type: 'string', minLength: 24, maxLength: 400 },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', minLength: 8, maxLength: 180 },
            },
          },
        },
      },
      blindSpots: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'risk', 'mitigation', 'evidence'],
          properties: {
            title: { type: 'string', minLength: 3, maxLength: 100 },
            risk: { type: 'string', minLength: 20, maxLength: 260 },
            mitigation: { type: 'string', minLength: 18, maxLength: 260 },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: 3,
              items: { type: 'string', minLength: 8, maxLength: 180 },
            },
          },
        },
      },
      roleFitMatrix: {
        type: 'array',
        minItems: 5,
        maxItems: 5,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['domain', 'fitScore', 'why', 'exampleRoles'],
          properties: {
            domain: { type: 'string', minLength: 3, maxLength: 80 },
            fitScore: { type: 'number', minimum: 0, maximum: 100 },
            why: { type: 'string', minLength: 18, maxLength: 240 },
            exampleRoles: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 3, maxLength: 80 },
            },
          },
        },
      },
      phasePlan: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['phase', 'goal', 'actions', 'kpis', 'risks'],
          properties: {
            phase: { type: 'string', enum: ['0_6_months', '6_18_months', '18_36_months'] },
            goal: { type: 'string', minLength: 14, maxLength: 220 },
            actions: {
              type: 'array',
              minItems: 3,
              maxItems: 5,
              items: { type: 'string', minLength: 12, maxLength: 180 },
            },
            kpis: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 8, maxLength: 120 },
            },
            risks: {
              type: 'array',
              minItems: 2,
              maxItems: 4,
              items: { type: 'string', minLength: 8, maxLength: 140 },
            },
          },
        },
      },
      decisionRules: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: { type: 'string', minLength: 12, maxLength: 200 },
      },
      next90DaysPlan: {
        type: 'array',
        minItems: 6,
        maxItems: 6,
        items: { type: 'string', minLength: 12, maxLength: 200 },
      },
    },
  },
} as const;

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function safeString(value: unknown, fallback: string, minLength = 1) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed.length >= minLength ? trimmed : fallback;
}

function buildEvidenceFromChart(chartPayload: ChartPromptPayload) {
  const topPlacements = chartPayload.placements
    .slice(0, 7)
    .map((entry) => `${entry.planet} in ${entry.sign}, house ${entry.house}`)
    .slice(0, 5);
  const topAspects = chartPayload.aspects
    .slice(0, 6)
    .map((entry) => `${entry.from}-${entry.to} ${entry.type}${entry.orb !== null ? ` (orb ${entry.orb})` : ''}`)
    .slice(0, 4);
  return {
    placements: topPlacements.length > 0 ? topPlacements : ['Core placements available from natal chart'],
    aspects: topAspects.length > 0 ? topAspects : ['Major aspect pattern available from natal chart'],
  };
}

function buildTemplateFallback(input: { chartPayload: ChartPromptPayload; context?: FullNatalContextInput }): FullNatalCareerAnalysisPayloadDoc {
  const evidence = buildEvidenceFromChart(input.chartPayload);
  const placementPrimary = evidence.placements[0] ?? 'Core placement signal';
  const placementSecondary = evidence.placements[1] ?? placementPrimary;
  const aspectPrimary = evidence.aspects[0] ?? 'Core aspect signal';
  const aspectSecondary = evidence.aspects[1] ?? aspectPrimary;
  const archetypes: FullNatalCareerArchetypeDoc[] = [
    { name: 'Strategic Builder', score: 82, evidence: evidence.placements.slice(0, 2) },
    { name: 'Systems Thinker', score: 78, evidence: evidence.aspects.slice(0, 2) },
    { name: 'Execution Optimizer', score: 76, evidence: [placementSecondary] },
  ];

  const strengths: FullNatalCareerStrengthDoc[] = [
    {
      title: 'Structured long-range planning',
      details: 'You tend to perform best when goals are sequenced into measurable milestones.',
      evidence: [placementPrimary],
    },
    {
      title: 'Learning velocity under complexity',
      details: 'You can absorb complex systems quickly when the context is explicit and outcome-focused.',
      evidence: [aspectPrimary],
    },
    {
      title: 'High accountability in delivery',
      details: 'You keep momentum when responsibilities and ownership boundaries are explicit.',
      evidence: [placementSecondary],
    },
    {
      title: 'Career signal awareness',
      details: 'You gain leverage by regularly reviewing environment fit and adjusting role scope.',
      evidence: [aspectSecondary],
    },
  ];

  const blindSpots: FullNatalCareerBlindSpotDoc[] = [
    {
      title: 'Overextension risk',
      risk: 'Taking on too many parallel initiatives can dilute impact.',
      mitigation: 'Prioritize one strategic objective per quarter and enforce drop criteria.',
      evidence: [aspectPrimary],
    },
    {
      title: 'Speed over calibration',
      risk: 'Fast execution can reduce decision quality on ambiguous opportunities.',
      mitigation: 'Use short decision memos with explicit assumptions before major commitments.',
      evidence: [aspectSecondary],
    },
    {
      title: 'Role-context mismatch',
      risk: 'Strong performance can drop in teams without clear decision ownership.',
      mitigation: 'Assess reporting structure and mandate clarity before accepting scope expansions.',
      evidence: [placementPrimary],
    },
  ];

  const roleFitMatrix: FullNatalCareerRoleFitDoc[] = [
    {
      domain: 'Product & Strategy',
      fitScore: 84,
      why: 'Combines systems thinking with prioritization leverage.',
      exampleRoles: ['Product Manager', 'Strategy Analyst', 'Program Lead'],
    },
    {
      domain: 'Operations & Process',
      fitScore: 80,
      why: 'Supports repeatable execution and measurable throughput gains.',
      exampleRoles: ['Operations Manager', 'Process Lead', 'Delivery Manager'],
    },
    {
      domain: 'Data & Analytics',
      fitScore: 77,
      why: 'Favors structured reasoning and evidence-backed decisions.',
      exampleRoles: ['Analytics Manager', 'BI Lead', 'Insights Analyst'],
    },
    {
      domain: 'Consulting & Advisory',
      fitScore: 75,
      why: 'Strong in diagnosing systems and translating them into practical actions.',
      exampleRoles: ['Consultant', 'Advisory Specialist', 'Transformation Lead'],
    },
    {
      domain: 'People Leadership',
      fitScore: 73,
      why: 'Best fit in goal-oriented teams with clear accountability lanes.',
      exampleRoles: ['Team Lead', 'Project Director', 'Functional Manager'],
    },
  ];

  const phasePlan: FullNatalCareerPhasePlanDoc[] = [
    {
      phase: '0_6_months',
      goal: 'Stabilize strategic direction and build measurable execution cadence.',
      actions: [
        'Define one primary career vector and two secondary options.',
        'Set a quarterly skill roadmap tied to target roles.',
        'Build a weekly review ritual for decisions and outcomes.',
      ],
      kpis: ['2 portfolio artifacts shipped', 'Weekly execution review consistency'],
      risks: ['Scope drift', 'Low priority clarity'],
    },
    {
      phase: '6_18_months',
      goal: 'Scale influence by owning higher-impact cross-functional outcomes.',
      actions: [
        'Lead one initiative with visible business metrics.',
        'Negotiate scope toward strategic problem ownership.',
        'Build reusable frameworks for recurring decisions.',
      ],
      kpis: ['One high-impact initiative delivered', 'Expanded decision ownership'],
      risks: ['Burnout via overcommitment', 'Unclear stakeholder alignment'],
    },
    {
      phase: '18_36_months',
      goal: 'Consolidate leadership positioning and long-term career leverage.',
      actions: [
        'Select specialization track and publish visible thought assets.',
        'Shape role architecture around strengths and sustainable load.',
        'Build mentorship and delegation systems.',
      ],
      kpis: ['Leadership scope expansion', 'Sustainable workload baseline'],
      risks: ['Identity lock-in', 'Underinvestment in delegation'],
    },
  ];

  const aiSignal =
    typeof input.context?.aiSynergyScore === 'number' && Number.isFinite(input.context.aiSynergyScore)
      ? `Current AI synergy signal: ${Math.round(input.context.aiSynergyScore)}%.`
      : 'AI synergy signal is not yet available for this profile.';

  return {
    schemaVersion: FULL_NATAL_SCHEMA_VERSION,
    headline: 'Full Natal Career Blueprint',
    executiveSummary:
      `This blueprint maps your natal chart into a long-range career strategy with phased execution priorities. ${aiSignal} ` +
      'Use it as a decision framework for role selection, growth sequencing, and sustainable performance.',
    careerArchetypes: archetypes,
    strengths,
    blindSpots,
    roleFitMatrix,
    phasePlan,
    decisionRules: [
      'Choose role scope before choosing title.',
      'Prefer clear mandate over broad visibility.',
      'Protect deep work windows every week.',
      'Convert strategic goals into measurable outputs.',
      'Review assumptions before major commitments.',
      'Trade speed for clarity when stakes are high.',
    ],
    next90DaysPlan: [
      'Define your primary 12-month career outcome in one paragraph.',
      'Create a weekly execution scoreboard with 3 lead indicators.',
      'Ship one portfolio artifact tied to your target role track.',
      'Run two informational interviews in your best-fit domain.',
      'Audit your current workload and remove one low-leverage stream.',
      'Schedule a monthly career decision retrospective.',
    ],
  };
}

export function normalizeLlmPayload(raw: unknown): FullNatalCareerAnalysisPayloadDoc | null {
  if (!raw || typeof raw !== 'object') return null;
  const root = raw as Record<string, unknown>;

  const toArchetypes = (input: unknown): FullNatalCareerArchetypeDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        name: safeString(item.name, 'Career Archetype', 2),
        score: clampScore(typeof item.score === 'number' ? item.score : 70),
        evidence: Array.isArray(item.evidence)
          ? item.evidence.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 4)
          : [],
      }))
      .filter((item) => item.evidence.length > 0)
      .slice(0, 4);
  };

  const toStrengths = (input: unknown): FullNatalCareerStrengthDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        title: safeString(item.title, 'Strength', 2),
        details: safeString(item.details, 'Strength details unavailable', 8),
        evidence: Array.isArray(item.evidence)
          ? item.evidence.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 3)
          : [],
      }))
      .filter((item) => item.evidence.length > 0)
      .slice(0, 4);
  };

  const toBlindSpots = (input: unknown): FullNatalCareerBlindSpotDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        title: safeString(item.title, 'Blind spot', 2),
        risk: safeString(item.risk, 'Risk details unavailable', 8),
        mitigation: safeString(item.mitigation, 'Mitigation details unavailable', 8),
        evidence: Array.isArray(item.evidence)
          ? item.evidence.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 3)
          : [],
      }))
      .filter((item) => item.evidence.length > 0)
      .slice(0, 3);
  };

  const toRoleFit = (input: unknown): FullNatalCareerRoleFitDoc[] => {
    if (!Array.isArray(input)) return [];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => ({
        domain: safeString(item.domain, 'General Domain', 2),
        fitScore: clampScore(typeof item.fitScore === 'number' ? item.fitScore : 70),
        why: safeString(item.why, 'Rationale unavailable', 8),
        exampleRoles: Array.isArray(item.exampleRoles)
          ? item.exampleRoles.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 4)
          : [],
      }))
      .filter((item) => item.exampleRoles.length >= 2)
      .slice(0, 5);
  };

  const toPhasePlan = (input: unknown): FullNatalCareerPhasePlanDoc[] => {
    if (!Array.isArray(input)) return [];
    const allowed: FullNatalCareerPhasePlanDoc['phase'][] = ['0_6_months', '6_18_months', '18_36_months'];
    return input
      .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
      .map((item) => {
        const phaseRaw = safeString(item.phase, '0_6_months');
        const phase = allowed.includes(phaseRaw as FullNatalCareerPhasePlanDoc['phase'])
          ? (phaseRaw as FullNatalCareerPhasePlanDoc['phase'])
          : '0_6_months';
        const list = (value: unknown, max: number) =>
          Array.isArray(value)
            ? value.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, max)
            : [];
        return {
          phase,
          goal: safeString(item.goal, 'Phase goal unavailable', 8),
          actions: list(item.actions, 5),
          kpis: list(item.kpis, 4),
          risks: list(item.risks, 4),
        };
      })
      .filter((item) => item.actions.length >= 2 && item.kpis.length >= 1 && item.risks.length >= 1)
      .slice(0, 3);
  };

  const careerArchetypes = toArchetypes(root.careerArchetypes);
  const strengths = toStrengths(root.strengths);
  const blindSpots = toBlindSpots(root.blindSpots);
  const roleFitMatrix = toRoleFit(root.roleFitMatrix);
  const phasePlan = toPhasePlan(root.phasePlan);
  const decisionRules = Array.isArray(root.decisionRules)
    ? root.decisionRules.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 6)
    : [];
  const next90DaysPlan = Array.isArray(root.next90DaysPlan)
    ? root.next90DaysPlan.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim()).filter(Boolean).slice(0, 6)
    : [];

  if (
    careerArchetypes.length < 3 ||
    strengths.length < 4 ||
    blindSpots.length < 3 ||
    roleFitMatrix.length < 5 ||
    phasePlan.length < 3 ||
    decisionRules.length < 6 ||
    next90DaysPlan.length < 6
  ) {
    return null;
  }

  return {
    schemaVersion: safeString(root.schemaVersion, FULL_NATAL_SCHEMA_VERSION),
    headline: safeString(root.headline, 'Full Natal Career Blueprint', 5),
    executiveSummary: safeString(root.executiveSummary, 'Career blueprint summary unavailable.', 20),
    careerArchetypes,
    strengths,
    blindSpots,
    roleFitMatrix,
    phasePlan,
    decisionRules,
    next90DaysPlan,
  };
}

export function getFullNatalAnalysisConfig() {
  const config = getFullNatalAnalysisPromptConfig();
  return {
    model: config.model,
    promptVersion: config.promptVersion,
  };
}

export async function generateFullNatalCareerAnalysis(input: {
  chartPayload: ChartPromptPayload;
  context?: FullNatalContextInput;
}): Promise<{
  analysis: FullNatalCareerAnalysisPayloadDoc;
  model: string;
  promptVersion: string;
  narrativeSource: 'template' | 'llm';
}> {
  const fallback = buildTemplateFallback(input);
  const config = getFullNatalAnalysisPromptConfig();
  const { model, promptVersion } = config;

  if (!env.OPENAI_FULL_NATAL_ANALYSIS_ENABLED || !env.OPENAI_API_KEY) {
    return {
      analysis: fallback,
      model,
      promptVersion,
      narrativeSource: 'template',
    };
  }

  const completion = await openAiStructuredGateway.requestStructuredCompletion({
    feature: config.feature,
    model,
    promptVersion,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    jsonSchema: OUTPUT_SCHEMA,
    messages: [
      { role: 'system', content: FULL_NATAL_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${FULL_NATAL_USER_PROMPT}

Input JSON:
${JSON.stringify({
  chartPayload: input.chartPayload,
  context: input.context ?? {},
  requiredSchemaVersion: FULL_NATAL_SCHEMA_VERSION,
})}`,
      },
    ],
    timeoutMs: config.timeoutMs,
  });

  const normalized = normalizeLlmPayload(completion.parsedContent);
  if (!normalized) {
    throw new Error('OpenAI full natal analysis payload format is invalid');
  }

  return {
    analysis: {
      ...normalized,
      schemaVersion: FULL_NATAL_SCHEMA_VERSION,
    },
    model,
    promptVersion,
    narrativeSource: 'llm',
  };
}
