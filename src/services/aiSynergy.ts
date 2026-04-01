import { ObjectId } from 'mongodb';
import type {
  AiSynergyComponentScoresDoc,
  AiSynergyConfidenceBreakdownDoc,
  AiSynergyDailyDoc,
  AiSynergySignalsDoc,
  AlgorithmTagDoc,
  DailyTransitVibeDoc,
  MongoCollections,
} from '../db/mongo.js';
import { getCollections } from '../db/mongo.js';
import { env } from '../config/env.js';
import { openAiStructuredGateway } from './llmGateway.js';
import { getAiSynergyPromptConfig } from './llmPromptRegistry.js';

type ChartPlacement = {
  planet: string;
  house: number;
  sign: string | null;
};

type ChartSnapshot = {
  placements: ChartPlacement[];
  aspects: Array<{ type: string; orb: number | null }>;
  houseSigns: Map<number, string>;
};

type SynergyBand = AiSynergyDailyDoc['band'];
type StyleProfile = 'analytical' | 'strategic' | 'energized' | 'calm';

type CreateAiSynergyInput = {
  userId: ObjectId;
  profileHash: string;
  dateKey: string;
  natalChart?: unknown | null;
  transitChart: unknown;
  transitVibe: DailyTransitVibeDoc;
  collections?: MongoCollections;
  forceRegenerate?: boolean;
};

export type AiSynergyView = {
  algorithmVersion: string;
  dateKey: string;
  narrativeSource: 'template' | 'llm';
  llmModel: string | null;
  llmPromptVersion: string | null;
  narrativeVariantId: string;
  styleProfile: string;
  score: number;
  scoreLabel: string;
  band: SynergyBand;
  confidence: number;
  confidenceBreakdown: AiSynergyConfidenceBreakdownDoc;
  headline: string;
  summary: string;
  description: string;
  recommendations: string[];
  tags: AlgorithmTagDoc[];
  drivers: string[];
  cautions: string[];
  actionsPriority: string[];
  components: AiSynergyComponentScoresDoc;
  signals: AiSynergySignalsDoc;
  generatedAt: string;
};

export type EnsureAiSynergyResult = {
  item: AiSynergyView;
  cached: boolean;
};

const AI_SYNERGY_ALGORITHM_VERSION = 'ai-synergy-v2';

const AI_SYNERGY_LLM_SYSTEM_PROMPT = [
  'You are a pragmatic AI productivity strategist in an astrology career app.',
  'You receive deterministic score components and astrological signals.',
  'Your task: rewrite narrative text to be concrete, practical, and varied.',
  'Do not claim certainty or guaranteed outcomes.',
  'Avoid medical/legal/financial advice.',
  'Do not change numeric scores or metrics.',
  'Output strict JSON only.',
].join(' ');

const AI_SYNERGY_LLM_USER_PROMPT = [
  'Generate daily AI synergy narrative.',
  'Requirements:',
  '- Keep language concise and actionable.',
  '- headline: 4..60 chars.',
  '- summary: 40..240 chars.',
  '- description: 120..520 chars.',
  '- recommendations: exactly 3 practical bullets.',
  '- Avoid repeating identical sentence openings.',
  '- Respect provided styleProfile while staying product-like.',
  '- Tone: product-like, clear, no mystic fluff.',
].join('\n');

const AI_SYNERGY_LLM_SCHEMA = {
  name: 'ai_synergy_narrative',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['headline', 'summary', 'description', 'recommendations'],
    properties: {
      headline: { type: 'string', minLength: 4, maxLength: 60 },
      summary: { type: 'string', minLength: 40, maxLength: 240 },
      description: { type: 'string', minLength: 120, maxLength: 520 },
      recommendations: {
        type: 'array',
        minItems: 3,
        maxItems: 3,
        items: { type: 'string', minLength: 12, maxLength: 170 },
      },
    },
  },
} as const;

const POSITIVE_ASPECT_TOKENS = ['trine', 'sextile'];
const HARD_ASPECT_TOKENS = ['square', 'opposition', 'quincunx'];

const PLANET_AI_BONUS: Record<string, number> = {
  mercury: 8,
  uranus: 7,
  saturn: 6,
  jupiter: 5,
  sun: 4,
  venus: 3,
  mars: 2,
  moon: 2,
  neptune: 1,
  pluto: 1,
};

const HOUSE_AI_BONUS: Record<number, number> = {
  3: 7,
  6: 8,
  10: 9,
  11: 8,
  7: 4,
  1: 3,
  9: 4,
  2: 2,
  8: 2,
};

const STYLE_PROFILES: StyleProfile[] = ['analytical', 'strategic', 'energized', 'calm'];

const HEADLINE_TEMPLATES: Record<SynergyBand, string[]> = {
  peak: [
    'Peak AI alignment window',
    'Top-tier AI execution day',
    'High-voltage AI leverage',
    'Exceptional AI workflow resonance',
    'Prime AI co-pilot timing',
    'Advanced AI decision window',
    'Elite automation momentum',
    'AI collaboration is fully online',
    'Strategic AI edge is active',
    'Today favors bold AI orchestration',
    'You are in maximal AI sync',
    'AI amplification day',
  ],
  strong: [
    'Strong AI collaboration day',
    'Reliable AI acceleration window',
    'Solid AI execution momentum',
    'AI support is clearly favorable',
    'Strong synergy for focused output',
    'AI leverage is above baseline',
    'Healthy AI workflow conditions',
    'Good day for AI-assisted delivery',
    'Stable AI co-pilot confidence',
    'AI can carry meaningful load today',
    'Productive AI sync is available',
    'Strong automation support signal',
  ],
  stable: [
    'Balanced AI synergy conditions',
    'Moderate AI assistance day',
    'Steady AI support window',
    'Controlled AI collaboration rhythm',
    'Usable AI momentum with discipline',
    'AI supports incremental progress',
    'Even-paced AI execution day',
    'Predictable AI output conditions',
    'Stable but selective AI leverage',
    'Measured AI productivity window',
    'Routine-friendly AI day',
    'Consistent AI co-work baseline',
  ],
  volatile: [
    'Volatile AI signal day',
    'Cautious AI collaboration window',
    'AI output needs tighter control',
    'Mixed AI quality conditions',
    'Precision-first AI workflow day',
    'AI requires extra guardrails today',
    'Deliberate pacing beats speed today',
    'High-noise AI day',
    'Validation-heavy AI conditions',
    'AI momentum is uneven today',
    'Risk-aware AI operations day',
    'Turbulent AI signal pattern',
  ],
};

const SUMMARY_OPENERS = [
  'Your natal pattern and today\'s transit',
  'The chart baseline combined with current sky motion',
  'Today\'s planetary geometry plus your natal strengths',
  'Your long-term chart bias with the daily transit layer',
  'The daily vibe merged with your natal signature',
  'Transit momentum mapped onto your core profile',
  'Current astrological pressure on your native workflow style',
  'Your baseline cognitive pattern under today\'s transit',
  'The present transit stack over your natal architecture',
  'Daily movement across houses aligned with your core tendencies',
  'Natal and transit vectors combined',
  'Your vocational chart interacting with the daily sky',
];

const DESCRIPTION_TECH = [
  'Push automation on structured tasks and keep human review for final judgement.',
  'Split work into deterministic and creative segments so AI can carry the repetitive load.',
  'Use AI for synthesis-first drafts, then apply strict editorial passes.',
  'Turn ambiguous tasks into checklists before delegating to models.',
  'Favor iterative prompting over one-shot generation for quality stability.',
  'Batch similar prompts to reduce context switching and improve consistency.',
  'Anchor prompts in explicit constraints to avoid output drift.',
  'Convert open questions into testable hypotheses before asking AI.',
  'Prioritize retrieval-grounded workflows over pure generation.',
  'Use role-based prompting only when goal criteria are explicit.',
  'Adopt template prompts for recurring operational decisions.',
  'Treat AI as a fast analyst, not an unquestioned authority.',
];

const DESCRIPTION_COLLAB = [
  'Collaboration quality improves when you frame intent and decision boundaries up front.',
  'Delegate exploration to AI and reserve final prioritization to yourself.',
  'Pair AI drafting with short review checkpoints to maintain speed and trust.',
  'Cross-team communication is smoother when AI outputs are summarized into action bullets.',
  'Use AI to pre-structure meetings, then adapt live based on stakeholder feedback.',
  'AI supports momentum best when goals are shared and traceable.',
  'Keep feedback loops short so AI-assisted iterations remain relevant.',
  'Human context should lead; AI should accelerate, not decide ownership.',
  'Set explicit quality bars before generating options with AI.',
  'Use AI to surface alternatives, then commit quickly to one execution path.',
  'Leverage AI for scenario comparison, not just content generation.',
  'Team alignment improves when AI outputs are converted into concrete next steps.',
];

const DESCRIPTION_RISK = [
  'Watch for overconfidence when speed rises faster than verification quality.',
  'Quality risk increases if prompts stay broad under deadline pressure.',
  'The main failure mode today is accepting plausible but weak outputs.',
  'Guard against context loss in long multi-step AI sessions.',
  'Avoid mixing exploratory and production prompts in one thread.',
  'Decision quality drops when generated options are not ranked explicitly.',
  'Bias risk grows if only one model response is considered.',
  'Misalignment appears when AI tone is trusted more than evidence.',
  'Operational noise rises if handoff formats are inconsistent.',
  'Scope creep is likely if task boundaries are not stated precisely.',
  'False certainty is the key risk on high-speed cycles.',
  'Model verbosity can hide weak reasoning if validation is skipped.',
];

const HOUSE_RECOMMENDATIONS: Record<number, string[]> = {
  1: [
    'Use AI to draft personal positioning or leadership communication.',
    'Prioritize visible initiatives where your decision speed matters.',
    'Treat AI outputs as options, then make a clear directional call.',
    'Anchor public-facing messages in concise, high-confidence framing.',
  ],
  3: [
    'Ideal day for writing, documentation, and communication workflows with AI.',
    'Batch message drafts and polish tone in a final pass.',
    'Use AI to summarize complex threads into decision-ready briefs.',
    'Turn scattered ideas into structured outlines before execution.',
  ],
  6: [
    'Automate repeatable operations and enforce QA checkpoints.',
    'Run process cleanup: AI can reveal hidden friction quickly.',
    'Use checklist-driven prompting for execution tasks.',
    'Focus on throughput and consistency rather than novelty.',
  ],
  7: [
    'Use AI to prepare negotiation or stakeholder alignment scenarios.',
    'Draft responses for multiple audiences before key conversations.',
    'Let AI map tradeoffs, then confirm relational impact manually.',
    'Prioritize collaborative tasks where framing matters.',
  ],
  10: [
    'Best used for strategic planning and high-stakes prioritization.',
    'AI can accelerate roadmap synthesis and executive-ready summaries.',
    'Concentrate on work with visible business impact.',
    'Use AI to compare options, then commit to one operational path.',
  ],
  11: [
    'Great day for innovation, systems thinking, and future-state design.',
    'Prototype workflows with AI and test them quickly with peers.',
    'Use AI to generate alternatives before group decisions.',
    'Push experiments that connect technology with team outcomes.',
  ],
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function hashString(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return hash >>> 0;
}

function pickBySeed(items: string[], seed: string, salt: string) {
  if (items.length === 0) return '';
  const index = hashString(`${seed}:${salt}`) % items.length;
  return items[index] ?? items[0] ?? '';
}

export function normalizeNarrativeFromLlm(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;
  if (
    typeof payload.headline !== 'string' ||
    typeof payload.summary !== 'string' ||
    typeof payload.description !== 'string' ||
    !Array.isArray(payload.recommendations)
  ) {
    return null;
  }

  const recommendations = payload.recommendations
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 3);

  if (recommendations.length < 3) return null;

  const headline = payload.headline.trim();
  const summary = payload.summary.trim();
  const description = payload.description.trim();

  if (headline.length < 4 || summary.length < 30 || description.length < 80) {
    return null;
  }

  return {
    headline,
    summary,
    description,
    recommendations,
  };
}

function normalizePlanet(input: unknown) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.includes('mercur')) return 'mercury';
  if (value.includes('venus')) return 'venus';
  if (value.includes('mars')) return 'mars';
  if (value.includes('jupiter')) return 'jupiter';
  if (value.includes('saturn')) return 'saturn';
  if (value.includes('uran')) return 'uranus';
  if (value.includes('nept')) return 'neptune';
  if (value.includes('pluto')) return 'pluto';
  if (value.includes('moon')) return 'moon';
  if (value.includes('sun')) return 'sun';
  return value;
}

function normalizeSign(input: unknown) {
  if (typeof input !== 'string') return null;
  const value = input.trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith('ari')) return 'aries';
  if (value.startsWith('tau')) return 'taurus';
  if (value.startsWith('gem')) return 'gemini';
  if (value.startsWith('can')) return 'cancer';
  if (value.startsWith('leo')) return 'leo';
  if (value.startsWith('vir')) return 'virgo';
  if (value.startsWith('lib')) return 'libra';
  if (value.startsWith('sco')) return 'scorpio';
  if (value.startsWith('sag')) return 'sagittarius';
  if (value.startsWith('cap')) return 'capricorn';
  if (value.startsWith('aqu')) return 'aquarius';
  if (value.startsWith('pis')) return 'pisces';
  return null;
}

function toOrdinalHouse(house: number) {
  if (house === 1) return '1st';
  if (house === 2) return '2nd';
  if (house === 3) return '3rd';
  return `${house}th`;
}

function extractChartSnapshot(chart: unknown): ChartSnapshot {
  if (!chart || typeof chart !== 'object') {
    return { placements: [], aspects: [], houseSigns: new Map() };
  }

  const root = chart as Record<string, unknown>;
  const housesRaw = Array.isArray(root.houses) ? root.houses : [];
  const aspectsRaw = Array.isArray(root.aspects) ? root.aspects : [];

  const houseSigns = new Map<number, string>();
  const placements: ChartPlacement[] = [];

  for (const houseEntry of housesRaw) {
    if (!houseEntry || typeof houseEntry !== 'object') continue;
    const house = houseEntry as Record<string, unknown>;
    const houseIdRaw = house.house_id;
    if (typeof houseIdRaw !== 'number' || !Number.isFinite(houseIdRaw)) continue;
    const houseId = Math.round(houseIdRaw);
    if (houseId < 1 || houseId > 12) continue;

    const sign = normalizeSign(house.sign);
    if (sign) houseSigns.set(houseId, sign);

    const planetsRaw = Array.isArray(house.planets) ? house.planets : [];
    for (const planetEntry of planetsRaw) {
      if (!planetEntry || typeof planetEntry !== 'object') continue;
      const planetObject = planetEntry as Record<string, unknown>;
      const planet = normalizePlanet(planetObject.name);
      if (!planet) continue;
      placements.push({
        planet,
        house: houseId,
        sign: normalizeSign(planetObject.sign),
      });
    }
  }

  const aspects = aspectsRaw
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      type: typeof entry.type === 'string' ? entry.type : '',
      orb:
        typeof entry.orb === 'number'
          ? Math.abs(entry.orb)
          : typeof entry.diff === 'number'
            ? Math.abs(entry.diff)
            : null,
    }));

  return { placements, aspects, houseSigns };
}

function countAspectBuckets(snapshot: ChartSnapshot) {
  let positive = 0;
  let hard = 0;
  let positiveStrength = 0;
  let hardStrength = 0;
  for (const aspect of snapshot.aspects) {
    const normalized = aspect.type.toLowerCase();
    const orbFactor = (() => {
      if (aspect.orb === null) return 0.72;
      const maxOrb = normalized.includes('sextile') ? 6 : normalized.includes('quincunx') ? 5 : 8;
      return clampFloat(1 - Math.min(aspect.orb, maxOrb) / maxOrb, 0.12, 1);
    })();

    if (POSITIVE_ASPECT_TOKENS.some((token) => normalized.includes(token))) {
      positive += 1;
      positiveStrength += (normalized.includes('trine') ? 1.18 : 0.92) * orbFactor;
    }
    if (HARD_ASPECT_TOKENS.some((token) => normalized.includes(token))) {
      hard += 1;
      hardStrength +=
        (normalized.includes('opposition') ? 1.28 : normalized.includes('square') ? 1.12 : 0.96) * orbFactor;
    }
  }
  return {
    positive,
    hard,
    positiveStrength: Number(positiveStrength.toFixed(2)),
    hardStrength: Number(hardStrength.toFixed(2)),
  };
}

function computeNatalBias(snapshot: ChartSnapshot) {
  let technical = 46;
  let communication = 44;

  for (const placement of snapshot.placements) {
    if (placement.planet === 'mercury') {
      technical += 4;
      communication += 6;
    }
    if (placement.planet === 'uranus') technical += 7;
    if (placement.planet === 'saturn') technical += 4;
    if (placement.planet === 'venus' || placement.planet === 'moon') communication += 3;

    if (placement.house === 3 || placement.house === 11) {
      communication += 3;
      technical += 2;
    }
    if (placement.house === 6 || placement.house === 10) {
      technical += 4;
    }
    if (placement.house === 7) communication += 2;
  }

  return {
    natalTechnicalBias: clamp(technical, 28, 95),
    natalCommunicationBias: clamp(communication, 28, 95),
  };
}

function planetDignityDelta(planet: string, sign: string | null) {
  if (!sign) return 0;
  const domicile: Record<string, string[]> = {
    sun: ['leo'],
    moon: ['cancer'],
    mercury: ['gemini', 'virgo'],
    venus: ['taurus', 'libra'],
    mars: ['aries', 'scorpio'],
    jupiter: ['sagittarius', 'pisces'],
    saturn: ['capricorn', 'aquarius'],
  };
  const detriment: Record<string, string[]> = {
    sun: ['aquarius'],
    moon: ['capricorn'],
    mercury: ['sagittarius', 'pisces'],
    venus: ['aries', 'scorpio'],
    mars: ['taurus', 'libra'],
    jupiter: ['gemini', 'virgo'],
    saturn: ['cancer', 'leo'],
  };
  const signKey = sign.toLowerCase();
  let delta = 0;
  if ((domicile[planet] ?? []).includes(signKey)) delta += 3;
  if ((detriment[planet] ?? []).includes(signKey)) delta -= 2.2;
  return delta;
}

function deriveSecondaryHouseSignal(transit: ChartSnapshot, dominantHouse: number) {
  const counts = new Map<number, number>();
  for (const placement of transit.placements) {
    counts.set(placement.house, (counts.get(placement.house) ?? 0) + 1);
  }

  const secondary = [...counts.entries()]
    .filter(([house]) => house !== dominantHouse)
    .sort((a, b) => b[1] - a[1] || b[0] - a[0])[0] ?? null;

  return {
    house: secondary?.[0] ?? null,
    density: secondary?.[1] ?? 0,
  };
}

function selectStyleProfile(seed: string, band: SynergyBand): StyleProfile {
  const styleSeed = `${seed}:${band}:style`;
  const idx = hashString(styleSeed) % STYLE_PROFILES.length;
  return STYLE_PROFILES[idx] ?? STYLE_PROFILES[0]!;
}

function toTag(group: string, label: string, score: number, reason: string): AlgorithmTagDoc {
  return {
    group,
    label,
    score: clamp(score, 0, 100),
    reason,
  };
}

function buildTags(input: {
  components: AiSynergyComponentScoresDoc;
  metrics: DailyTransitVibeDoc['metrics'];
  dominantHouse: number;
  positiveStrength: number;
  hardStrength: number;
  natalBias: ReturnType<typeof computeNatalBias>;
}) {
  const { components, metrics, dominantHouse, positiveStrength, hardStrength, natalBias } = input;
  const hardPressure = hardStrength * 8;
  const supportiveFlow = positiveStrength * 7;

  return [
    toTag(
      'work_mode',
      'execution',
      metrics.energy * 0.46 + metrics.focus * 0.36 + (dominantHouse === 10 || dominantHouse === 6 ? 12 : 3),
      'Energy and execution houses increase operational throughput.'
    ),
    toTag(
      'work_mode',
      'strategy',
      components.decisionQuality * 0.62 + components.cognitiveFlow * 0.22 + (dominantHouse === 10 ? 8 : 2),
      'Decision quality and strategic houses support planning depth.'
    ),
    toTag(
      'work_mode',
      'networking',
      components.collaborationWithAI * 0.7 + (dominantHouse === 7 || dominantHouse === 11 ? 16 : 5) - hardPressure * 0.2,
      'Collaboration potential tracks social-house emphasis and communication bias.'
    ),
    toTag(
      'work_mode',
      'creative',
      metrics.luck * 0.62 + components.cognitiveFlow * 0.25 + supportiveFlow * 0.6,
      'Luck and supportive aspects increase ideation quality.'
    ),
    toTag(
      'work_mode',
      'recovery',
      58 - metrics.energy * 0.24 + hardPressure * 0.32,
      'Hard aspect pressure increases recovery requirement.'
    ),
    toTag(
      'ai_mode',
      'automation',
      components.automationReadiness * 0.82 + components.decisionQuality * 0.14,
      'Automation readiness is the primary predictor for workflow delegation.'
    ),
    toTag(
      'ai_mode',
      'research',
      components.cognitiveFlow * 0.7 + components.decisionQuality * 0.24 + natalBias.natalTechnicalBias * 0.08,
      'Cognitive flow and technical bias support structured research usage.'
    ),
    toTag(
      'ai_mode',
      'drafting',
      components.cognitiveFlow * 0.58 + components.collaborationWithAI * 0.28 + supportiveFlow * 0.45,
      'Flow plus collaborative capacity improves drafting consistency.'
    ),
    toTag(
      'ai_mode',
      'evaluation',
      components.decisionQuality * 0.78 + hardPressure * 0.22,
      'Decision quality and pressure handling determine evaluation reliability.'
    ),
    toTag(
      'ai_mode',
      'review',
      components.decisionQuality * 0.55 + components.automationReadiness * 0.2 + hardPressure * 0.35,
      'Review demand rises when hard aspects and throughput pressure overlap.'
    ),
    toTag(
      'risk',
      'overconfidence',
      metrics.energy * 0.42 + components.automationReadiness * 0.2 - components.decisionQuality * 0.22 + hardPressure * 0.18,
      'High speed with lower review discipline can inflate confidence risk.'
    ),
    toTag(
      'risk',
      'context_switch',
      34 + hardPressure * 0.6 + (dominantHouse === 3 || dominantHouse === 11 ? 9 : 0) - metrics.focus * 0.25,
      'Signal fragmentation and social-context load increase switching cost.'
    ),
    toTag(
      'risk',
      'communication_noise',
      30 + hardPressure * 0.52 + (dominantHouse === 7 ? 8 : 2) - natalBias.natalCommunicationBias * 0.18,
      'High relational pressure can reduce communication clarity.'
    ),
    toTag(
      'risk',
      'rush_bias',
      28 + metrics.energy * 0.35 + hardPressure * 0.22 - components.decisionQuality * 0.2,
      'Fast execution can outpace validation cycles under pressure.'
    ),
    toTag(
      'timing',
      'deep_work_window',
      components.cognitiveFlow * 0.62 + components.decisionQuality * 0.22 + supportiveFlow * 0.4 - hardPressure * 0.3,
      'Deep work quality follows flow, decision signal, and aspect coherence.'
    ),
    toTag(
      'timing',
      'collab_window',
      components.collaborationWithAI * 0.72 + supportiveFlow * 0.55 - hardPressure * 0.24,
      'Collaboration windows depend on social alignment and low friction.'
    ),
    toTag(
      'timing',
      'admin_window',
      components.automationReadiness * 0.56 + hardPressure * 0.18 + (dominantHouse === 6 ? 11 : 2),
      'Operational windows improve when process-oriented signals are active.'
    ),
    toTag(
      'industry_bias',
      'product',
      components.decisionQuality * 0.46 + components.collaborationWithAI * 0.28 + (dominantHouse === 10 ? 7 : 0),
      'Product work benefits from balanced decision and collaboration signal.'
    ),
    toTag(
      'industry_bias',
      'engineering',
      components.automationReadiness * 0.5 + natalBias.natalTechnicalBias * 0.35 + components.decisionQuality * 0.16,
      'Technical bias and automation readiness favor engineering workflows.'
    ),
    toTag(
      'industry_bias',
      'sales',
      components.collaborationWithAI * 0.48 + metrics.luck * 0.4 + (dominantHouse === 7 ? 10 : 0),
      'Collaboration and timing luck influence persuasion-heavy activity.'
    ),
    toTag(
      'industry_bias',
      'operations',
      components.automationReadiness * 0.42 + components.decisionQuality * 0.38 + (dominantHouse === 6 ? 9 : 2),
      'Operational roles favor repeatable execution and quality control.'
    ),
    toTag(
      'industry_bias',
      'content',
      components.cognitiveFlow * 0.44 + components.collaborationWithAI * 0.24 + metrics.luck * 0.2,
      'Narrative and synthesis-heavy work tracks flow and communication signal.'
    ),
  ];
}

function topTagsByGroup(tags: AlgorithmTagDoc[], group: string, count: number) {
  return tags
    .filter((tag) => tag.group === group)
    .sort((a, b) => b.score - a.score)
    .slice(0, count);
}

function buildDriversAndCautions(input: {
  components: AiSynergyComponentScoresDoc;
  tags: AlgorithmTagDoc[];
  dominantPlanet: string;
  dominantHouse: number;
  positiveStrength: number;
  hardStrength: number;
}) {
  const topAiModes = topTagsByGroup(input.tags, 'ai_mode', 2);
  const topWorkModes = topTagsByGroup(input.tags, 'work_mode', 2);
  const topRisks = topTagsByGroup(input.tags, 'risk', 2);

  const drivers = [
    `${input.dominantPlanet[0]?.toUpperCase() ?? ''}${input.dominantPlanet.slice(1)} in ${toOrdinalHouse(input.dominantHouse)} house directs the core workflow tone.`,
    `Top AI modes: ${topAiModes.map((tag) => tag.label).join(', ')}.`,
    `Top work modes: ${topWorkModes.map((tag) => tag.label).join(', ')}.`,
  ];

  const cautions = [
    topRisks[0] ? `Primary risk signal: ${topRisks[0].label}.` : 'Primary risk signal is moderate.',
    input.hardStrength > input.positiveStrength
      ? 'Hard aspect strength exceeds supportive flow; increase review checkpoints.'
      : 'Supportive aspect strength is higher; keep quality gates explicit to avoid drift.',
    input.components.decisionQuality < 70
      ? 'Decision quality is below optimal range; require stricter evidence checks.'
      : 'Decision quality is stable, but maintain final human approval discipline.',
  ];

  const actionsPriority = [
    `Prioritize ${topAiModes[0]?.label ?? 'automation'} workflows first.`,
    `Schedule ${topWorkModes[0]?.label ?? 'execution'} tasks in your highest-focus window.`,
    `Mitigate ${topRisks[0]?.label ?? 'context_switch'} with shorter review loops.`,
  ];

  return { drivers, cautions, actionsPriority };
}

function computeConfidenceBreakdown(input: {
  natal: ChartSnapshot;
  transit: ChartSnapshot;
  positiveStrength: number;
  hardStrength: number;
  momentumScore: number;
}) {
  const dataQuality = clamp(
    52 +
      Math.min(18, input.natal.placements.length * 1.5) +
      Math.min(14, input.transit.placements.length * 0.9) +
      Math.min(9, input.transit.aspects.length * 0.7),
    35,
    99
  );
  const coherence = clamp(
    48 +
      input.positiveStrength * 6.2 -
      input.hardStrength * 2.8 +
      Math.min(8, input.transit.aspects.length * 0.5),
    28,
    98
  );
  const stability = clamp(
    64 -
      Math.abs(input.momentumScore) * 4.8 +
      (input.hardStrength <= input.positiveStrength ? 6 : -2),
    24,
    96
  );

  return {
    dataQuality,
    coherence,
    stability,
  } satisfies AiSynergyConfidenceBreakdownDoc;
}

function scoreBand(score: number): SynergyBand {
  if (score >= 88) return 'peak';
  if (score >= 76) return 'strong';
  if (score >= 64) return 'stable';
  return 'volatile';
}

function buildRecommendations(seed: string, dominantHouse: number, components: AiSynergyComponentScoresDoc) {
  const generic = [
    'Time-box AI sessions and end each block with a human decision checkpoint.',
    'Prefer evidence-backed prompts over broad exploratory wording.',
    'Track prompt/result pairs that worked well for reuse tomorrow.',
    'Use one owner for final approval on AI-assisted outputs.',
    'Separate ideation and execution prompts into different threads.',
    'Translate generated output into explicit next actions immediately.',
  ];

  const houseSpecific = HOUSE_RECOMMENDATIONS[dominantHouse] ?? [
    'Keep scope narrow and iterate quickly with measurable checkpoints.',
    'Prioritize tasks where AI can reduce mechanical overhead.',
    'Use short feedback loops to stabilize quality.',
    'Capture decisions and assumptions after each major AI interaction.',
  ];

  const qualityBoost =
    components.decisionQuality < 70
      ? 'Double-check factual claims and prioritize validation over speed.'
      : 'Use your strong decision window to convert AI options into commitments.';

  const automationBoost =
    components.automationReadiness < 68
      ? 'Stay with semi-automated workflows; avoid fully autonomous execution today.'
      : 'Expand automation on repetitive flows and monitor outputs at milestones.';

  const picks = [
    pickBySeed(houseSpecific, seed, 'house-rec-1'),
    pickBySeed(houseSpecific, seed, 'house-rec-2'),
    pickBySeed(generic, seed, 'generic-rec-1'),
    qualityBoost,
    automationBoost,
  ];

  const unique: string[] = [];
  for (const entry of picks) {
    if (unique.includes(entry)) continue;
    unique.push(entry);
    if (unique.length >= 3) break;
  }
  return unique;
}

function buildNarrative(input: {
  seed: string;
  score: number;
  band: SynergyBand;
  styleProfile: StyleProfile;
  components: AiSynergyComponentScoresDoc;
  signals: AiSynergySignalsDoc;
  vibe: DailyTransitVibeDoc;
  drivers: string[];
  cautions: string[];
  actionsPriority: string[];
}) {
  const houseLabel = toOrdinalHouse(input.signals.dominantHouse);
  const planet = input.signals.dominantPlanet;

  const headlinePrefixByStyle: Record<StyleProfile, string> = {
    analytical: 'Signal',
    strategic: 'Strategy',
    energized: 'Momentum',
    calm: 'Steady',
  };
  const headlineBase = pickBySeed(HEADLINE_TEMPLATES[input.band], input.seed, `${input.styleProfile}:headline`);
  const headline = `${headlinePrefixByStyle[input.styleProfile]}: ${headlineBase}`.slice(0, 60);
  const opener = pickBySeed(SUMMARY_OPENERS, input.seed, `${input.styleProfile}:summary-opener`);
  const techSentence = pickBySeed(DESCRIPTION_TECH, input.seed, 'desc-tech');
  const collabSentence = pickBySeed(DESCRIPTION_COLLAB, input.seed, 'desc-collab');
  const riskSentence = pickBySeed(DESCRIPTION_RISK, input.seed, 'desc-risk');

  const summary =
    `${opener} yields AI synergy score ${input.score}% today. ` +
    `${planet[0]?.toUpperCase() ?? ''}${planet.slice(1)} in ${houseLabel} house supports ${input.vibe.modeLabel.toLowerCase()}. ` +
    `${input.drivers[0] ?? 'Execution signal is stable.'}`;

  const description =
    `${techSentence} ${collabSentence} ${riskSentence} ` +
    `Priority: ${input.actionsPriority[0] ?? 'Start with high-confidence AI tasks.'} ` +
    `Caution: ${input.cautions[0] ?? 'Keep review loops explicit.'}`;

  return { headline, summary, description };
}

type ComputedAiSynergyPayload = Omit<AiSynergyView, 'generatedAt'>;

function computeAiSynergyPayload(input: {
  seed: string;
  dateKey: string;
  natalChart: unknown | null;
  transitChart: unknown;
  vibe: DailyTransitVibeDoc;
}) {
  const natal = extractChartSnapshot(input.natalChart);
  const transit = extractChartSnapshot(input.transitChart);
  const natalBias = computeNatalBias(natal);
  const { positive, hard, positiveStrength, hardStrength } = countAspectBuckets(transit);

  const dominantPlanet = normalizePlanet(input.vibe.dominant.planet) ?? 'sun';
  const dominantHouse = input.vibe.dominant.house;
  const dominantSign = normalizeSign(input.vibe.dominant.sign);
  const planetBoost = PLANET_AI_BONUS[dominantPlanet] ?? 2;
  const houseBoost = HOUSE_AI_BONUS[dominantHouse] ?? 2;
  const secondarySignal = deriveSecondaryHouseSignal(transit, dominantHouse);
  const secondaryHouse = input.vibe.signals?.secondaryHouse ?? secondarySignal.house;
  const secondaryHouseDensity = input.vibe.signals?.secondaryHouseDensity ?? secondarySignal.density;
  const momentumScore = input.vibe.signals?.momentum
    ? (input.vibe.signals.momentum.energy + input.vibe.signals.momentum.focus + input.vibe.signals.momentum.luck) / 3
    : 0;
  const dignityBalance = planetDignityDelta(dominantPlanet, dominantSign) + (input.vibe.signals?.dignityBalance ?? 0) * 0.35;
  const phaseModifier = input.vibe.dominant.retrograde ? -3.2 : 1.6;

  const cognitiveFlow = clamp(
    21 +
      input.vibe.metrics.focus * 0.58 +
      natalBias.natalCommunicationBias * 0.22 +
      planetBoost * 1.4 +
      positiveStrength * 2.4 -
      hardStrength * 2.05 +
      phaseModifier * 0.65 +
      dignityBalance * 0.8 +
      momentumScore * 0.8,
    24,
    98
  );

  const automationReadiness = clamp(
    19 +
      input.vibe.metrics.energy * 0.34 +
      natalBias.natalTechnicalBias * 0.42 +
      houseBoost * 1.6 +
      planetBoost * 1.2 +
      positiveStrength * 2.15 -
      hardStrength * 1.45 +
      secondaryHouseDensity * 1.25 +
      (secondaryHouse === 6 || secondaryHouse === 10 ? 3 : 0) +
      dignityBalance * 0.5,
    22,
    98
  );

  const decisionQuality = clamp(
    23 +
      input.vibe.metrics.focus * 0.44 +
      input.vibe.metrics.luck * 0.18 +
      natalBias.natalTechnicalBias * 0.18 +
      (dominantHouse === 10 ? 6 : 0) +
      (dominantHouse === 6 ? 4 : 0) +
      positiveStrength * 2.05 -
      hardStrength * 2.2 +
      dignityBalance * 0.92 -
      momentumScore * 0.6,
    20,
    97
  );

  const collaborationWithAI = clamp(
    18 +
      input.vibe.metrics.energy * 0.24 +
      input.vibe.metrics.luck * 0.22 +
      natalBias.natalCommunicationBias * 0.45 +
      ((dominantHouse === 7 || dominantHouse === 11) ? 7 : 0) +
      ((dominantPlanet === 'mercury' || dominantPlanet === 'venus') ? 5 : 0) +
      positiveStrength * 1.95 -
      hardStrength * 1.28 +
      (secondaryHouse === 3 || secondaryHouse === 11 ? 4 : 0),
    20,
    98
  );

  const score = clamp(
    cognitiveFlow * 0.31 +
      automationReadiness * 0.3 +
      decisionQuality * 0.23 +
      collaborationWithAI * 0.16,
    18,
    98
  );

  const confidenceBreakdown = computeConfidenceBreakdown({
    natal,
    transit,
    positiveStrength,
    hardStrength,
    momentumScore,
  });
  const confidence = clamp(
    confidenceBreakdown.dataQuality * 0.38 +
      confidenceBreakdown.coherence * 0.37 +
      confidenceBreakdown.stability * 0.25,
    35,
    99
  );

  const band = scoreBand(score);
  const styleProfile = selectStyleProfile(input.seed, band);
  const tags = buildTags({
    components: {
      cognitiveFlow,
      automationReadiness,
      decisionQuality,
      collaborationWithAI,
    },
    metrics: input.vibe.metrics,
    dominantHouse,
    positiveStrength,
    hardStrength,
    natalBias,
  });
  const { drivers, cautions, actionsPriority } = buildDriversAndCautions({
    components: {
      cognitiveFlow,
      automationReadiness,
      decisionQuality,
      collaborationWithAI,
    },
    tags,
    dominantPlanet: input.vibe.dominant.planet,
    dominantHouse,
    positiveStrength,
    hardStrength,
  });
  const narrativeVariantId = `${styleProfile}-${band}-${String(hashString(`${input.seed}:variant`) % 24).padStart(2, '0')}`;

  const signals: AiSynergySignalsDoc = {
    dominantPlanet: input.vibe.dominant.planet,
    dominantHouse,
    mcSign: natal.houseSigns.get(10) ?? null,
    ascSign: natal.houseSigns.get(1) ?? null,
    positiveAspects: positive,
    hardAspects: hard,
    positiveAspectStrength: Number(positiveStrength.toFixed(2)),
    hardAspectStrength: Number(hardStrength.toFixed(2)),
    secondaryHouse,
    secondaryHouseDensity,
    dignityBalance: Number(dignityBalance.toFixed(2)),
    momentumScore: Number(momentumScore.toFixed(2)),
    natalTechnicalBias: natalBias.natalTechnicalBias,
    natalCommunicationBias: natalBias.natalCommunicationBias,
  };

  const components: AiSynergyComponentScoresDoc = {
    cognitiveFlow,
    automationReadiness,
    decisionQuality,
    collaborationWithAI,
  };

  const narrative = buildNarrative({
    seed: input.seed,
    score,
    band,
    styleProfile,
    components,
    signals,
    vibe: input.vibe,
    drivers,
    cautions,
    actionsPriority,
  });

  return {
    algorithmVersion: AI_SYNERGY_ALGORITHM_VERSION,
    dateKey: input.dateKey,
    narrativeSource: 'template',
    llmModel: null,
    llmPromptVersion: null,
    narrativeVariantId,
    styleProfile,
    score,
    scoreLabel: `${score}%`,
    band,
    confidence,
    confidenceBreakdown,
    headline: narrative.headline,
    summary: narrative.summary,
    description: narrative.description,
    recommendations: buildRecommendations(input.seed, dominantHouse, components),
    tags,
    drivers,
    cautions,
    actionsPriority,
    components,
    signals,
  } satisfies ComputedAiSynergyPayload;
}

async function maybeEnhanceNarrativeWithLlm(
  base: ComputedAiSynergyPayload,
  transitVibe: DailyTransitVibeDoc
): Promise<ComputedAiSynergyPayload> {
  if (!env.OPENAI_AI_SYNERGY_ENABLED) return base;
  if (!env.OPENAI_API_KEY) return base;

  const config = getAiSynergyPromptConfig();
  const { model, promptVersion } = config;
  const completion = await openAiStructuredGateway.requestStructuredCompletion({
    feature: config.feature,
    model,
    promptVersion,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    jsonSchema: AI_SYNERGY_LLM_SCHEMA,
    messages: [
      { role: 'system', content: AI_SYNERGY_LLM_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${AI_SYNERGY_LLM_USER_PROMPT}

Context JSON:
${JSON.stringify(
  {
    algorithmVersion: base.algorithmVersion,
    narrativeVariantId: base.narrativeVariantId,
    styleProfile: base.styleProfile,
    score: base.score,
    band: base.band,
    confidence: base.confidence,
    confidenceBreakdown: base.confidenceBreakdown,
    components: base.components,
    signals: base.signals,
    tags: base.tags,
    drivers: base.drivers,
    cautions: base.cautions,
    actionsPriority: base.actionsPriority,
    transit: {
      title: transitVibe.title,
      modeLabel: transitVibe.modeLabel,
      summary: transitVibe.summary,
    },
    deterministicDraft: {
      headline: base.headline,
      summary: base.summary,
      description: base.description,
      recommendations: base.recommendations,
    },
  },
  null,
  0
)}`,
      },
    ],
    timeoutMs: config.timeoutMs,
  });

  const parsed = normalizeNarrativeFromLlm(completion.parsedContent);
  if (!parsed) {
    throw new Error('OpenAI AI synergy narrative payload format is invalid');
  }

  return {
    ...base,
    narrativeSource: 'llm',
    llmModel: model,
    llmPromptVersion: promptVersion,
    headline: parsed.headline,
    summary: parsed.summary,
    description: parsed.description,
    recommendations: parsed.recommendations,
  };
}

function toView(doc: AiSynergyDailyDoc): AiSynergyView {
  return {
    algorithmVersion: doc.algorithmVersion,
    dateKey: doc.dateKey,
    narrativeSource: (doc.narrativeSource ?? 'template') as 'template' | 'llm',
    llmModel: doc.llmModel ?? null,
    llmPromptVersion: doc.llmPromptVersion ?? null,
    narrativeVariantId: doc.narrativeVariantId ?? 'analytical-stable-00',
    styleProfile: doc.styleProfile ?? 'analytical',
    score: doc.score,
    scoreLabel: `${doc.score}%`,
    band: doc.band,
    confidence: doc.confidence,
    confidenceBreakdown: doc.confidenceBreakdown ?? {
      dataQuality: doc.confidence,
      coherence: doc.confidence,
      stability: doc.confidence,
    },
    headline: doc.headline,
    summary: doc.summary,
    description: doc.description,
    recommendations: doc.recommendations,
    tags: doc.tags ?? [],
    drivers: doc.drivers ?? [],
    cautions: doc.cautions ?? [],
    actionsPriority: doc.actionsPriority ?? [],
    components: doc.components,
    signals: doc.signals,
    generatedAt: doc.generatedAt.toISOString(),
  };
}

function toViewFromComputed(
  computed: ComputedAiSynergyPayload,
  generatedAt: Date,
): AiSynergyView {
  return {
    ...computed,
    generatedAt: generatedAt.toISOString(),
  };
}

export async function getOrCreateAiSynergyForDay(input: CreateAiSynergyInput): Promise<EnsureAiSynergyResult> {
  const collections = input.collections ?? (await getCollections());
  const existing = input.forceRegenerate
    ? null
    : await collections.aiSynergyDaily.findOne({
        userId: input.userId,
        profileHash: input.profileHash,
        dateKey: input.dateKey,
        algorithmVersion: AI_SYNERGY_ALGORITHM_VERSION,
      });

  if (existing) {
    return { item: toView(existing), cached: true };
  }

  const natalChart =
    input.natalChart !== undefined
      ? input.natalChart
      : (
          await collections.natalCharts.findOne(
            {
              userId: input.userId,
              profileHash: input.profileHash,
            },
            { projection: { chart: 1 } },
          )
        )?.chart ?? null;

  const seed = `${input.userId.toHexString()}:${input.profileHash}:${input.dateKey}:${input.transitVibe.dominant.planet}:${input.transitVibe.dominant.house}`;
  const deterministic = computeAiSynergyPayload({
    seed,
    dateKey: input.dateKey,
    natalChart,
    transitChart: input.transitChart,
    vibe: input.transitVibe,
  });
  const computed = await (async () => {
    try {
      return await maybeEnhanceNarrativeWithLlm(deterministic, input.transitVibe);
    } catch {
      return deterministic;
    }
  })();

  const now = new Date();
  await collections.aiSynergyDaily.updateOne(
    {
      userId: input.userId,
      profileHash: input.profileHash,
      dateKey: input.dateKey,
      algorithmVersion: AI_SYNERGY_ALGORITHM_VERSION,
    },
    {
      $set: {
        narrativeSource: computed.narrativeSource,
        llmModel: computed.llmModel,
        llmPromptVersion: computed.llmPromptVersion,
        narrativeVariantId: computed.narrativeVariantId,
        styleProfile: computed.styleProfile,
        score: computed.score,
        band: computed.band,
        confidence: computed.confidence,
        confidenceBreakdown: computed.confidenceBreakdown,
        tags: computed.tags,
        drivers: computed.drivers,
        cautions: computed.cautions,
        actionsPriority: computed.actionsPriority,
        components: computed.components,
        signals: computed.signals,
        headline: computed.headline,
        summary: computed.summary,
        description: computed.description,
        recommendations: computed.recommendations,
        generatedAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true }
  );

  return {
    item: toViewFromComputed(computed, now),
    cached: false,
  };
}

export async function listAiSynergyHistory(input: {
  userId: ObjectId;
  days: number;
  limit: number;
}) {
  const collections = await getCollections();
  const fromDate = new Date();
  fromDate.setDate(fromDate.getDate() - Math.max(1, input.days));
  const minDateKey = fromDate.toISOString().slice(0, 10);

  const docs = await collections.aiSynergyDaily
    .find({
      userId: input.userId,
      dateKey: { $gte: minDateKey },
      algorithmVersion: AI_SYNERGY_ALGORITHM_VERSION,
    })
    .sort({ dateKey: -1 })
    .limit(Math.max(1, Math.min(90, input.limit)))
    .toArray();

  return docs.map((doc) => toView(doc));
}
