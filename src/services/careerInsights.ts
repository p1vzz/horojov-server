import { env } from '../config/env.js';
import { openAiStructuredGateway } from './llmGateway.js';
import { getCareerInsightsPromptConfig } from './llmPromptRegistry.js';

export type InsightTier = 'free' | 'premium';

export type CareerInsightItem = {
  title: string;
  tag: string;
  description: string;
  actions: string[];
};

export type CareerInsightsPayload = {
  summary: string;
  insights: CareerInsightItem[];
};

export type ChartPromptPayload = {
  ascSign: string;
  mcSign: string;
  placements: Array<{
    planet: string;
    sign: string;
    house: number;
    fullDegree: number;
    retrograde: boolean;
  }>;
  aspects: Array<{
    from: string;
    to: string;
    type: string;
    orb: number | null;
  }>;
};

const MIN_INSIGHTS = 3;
const MAX_INSIGHTS = 5;

const FREE_SYSTEM_PROMPT = [
  'You are a pragmatic vocational astrology assistant for a career app.',
  'Use only the natal chart data provided by the user message.',
  'Write clear, practical, non-fatalistic guidance.',
  'Do not mention health, legal, or guaranteed outcomes.',
  'Tone: concise, useful, motivating but realistic.',
  'Output only valid JSON that matches schema.',
].join(' ');

const FREE_USER_PROMPT = [
  'Create FREE-TIER career insights.',
  'Depth requirements:',
  '- Surface-level and quick to read.',
  '- 3 to 4 insights total.',
  '- Each description: 1-2 short sentences.',
  '- Actions: max 1 simple next step.',
  '- Tags should be simple labels like "Strength", "Focus", "Communication", "Growth".',
  'Avoid heavy astrological jargon.',
].join('\n');

const PREMIUM_SYSTEM_PROMPT = [
  'You are a senior vocational astrology strategist for premium subscribers.',
  'Use only provided chart data and stay practical.',
  'Provide deeper interpretation, blind spots, and strategic actions.',
  'No deterministic predictions. No health/legal/financial guarantees.',
  'Output only valid JSON that matches schema.',
].join(' ');

const PREMIUM_USER_PROMPT = [
  'Create PREMIUM-TIER career insights.',
  'Depth requirements:',
  '- Exactly 5 insights total.',
  '- Each description: 2-4 concrete sentences with cause/effect reasoning.',
  '- Mention relevant placements/aspects/houses in plain language.',
  '- Include exactly 3 actions for each insight.',
  '- Tags can be strategic labels like "Leverage", "Risk", "Timing", "Leadership", "Execution".',
  'The output should feel significantly deeper than free-tier insights.',
].join('\n');

const OUTPUT_SCHEMA = {
  name: 'career_insights',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'insights'],
    properties: {
      summary: { type: 'string', minLength: 20, maxLength: 260 },
      insights: {
        type: 'array',
        minItems: MIN_INSIGHTS,
        maxItems: MAX_INSIGHTS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'tag', 'description', 'actions'],
          properties: {
            title: { type: 'string', minLength: 4, maxLength: 80 },
            tag: { type: 'string', minLength: 3, maxLength: 24 },
            description: { type: 'string', minLength: 20, maxLength: 560 },
            actions: {
              type: 'array',
              maxItems: 4,
              items: { type: 'string', minLength: 4, maxLength: 140 },
            },
          },
        },
      },
    },
  },
} as const;

function modelForTier(tier: InsightTier) {
  return getCareerInsightsPromptConfig(tier).model;
}

function maxTokensForTier(tier: InsightTier) {
  return getCareerInsightsPromptConfig(tier).maxTokens;
}

function promptForTier(tier: InsightTier) {
  if (tier === 'premium') {
    return {
      system: PREMIUM_SYSTEM_PROMPT,
      user: PREMIUM_USER_PROMPT,
    };
  }
  return {
    system: FREE_SYSTEM_PROMPT,
    user: FREE_USER_PROMPT,
  };
}

export function getInsightsConfig(tier: InsightTier) {
  const config = getCareerInsightsPromptConfig(tier);
  return {
    model: config.model,
    promptVersion: config.promptVersion,
  };
}

function parseJsonSafely(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

export function normalizeInsightsPayload(tier: InsightTier, parsed: unknown): CareerInsightsPayload | null {
  if (!parsed || typeof parsed !== 'object') return null;
  const data = parsed as Record<string, unknown>;
  if (typeof data.summary !== 'string' || !Array.isArray(data.insights)) return null;

  const insights: CareerInsightItem[] = [];
  for (const raw of data.insights) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (typeof item.title !== 'string' || typeof item.tag !== 'string' || typeof item.description !== 'string') {
      continue;
    }

    const actions = Array.isArray(item.actions)
      ? item.actions.filter((entry): entry is string => typeof entry === 'string').slice(0, tier === 'premium' ? 3 : 1)
      : [];

    insights.push({
      title: item.title.trim(),
      tag: item.tag.trim(),
      description: item.description.trim(),
      actions,
    });
  }

  const normalizedInsights = insights.slice(0, MAX_INSIGHTS);
  if (normalizedInsights.length < MIN_INSIGHTS) return null;

  return {
    summary: data.summary.trim(),
    insights: normalizedInsights,
  };
}

export async function generateCareerInsights(input: {
  tier: InsightTier;
  chartPayload: ChartPromptPayload;
}): Promise<{ insights: CareerInsightsPayload; model: string; promptVersion: string }> {
  const tier = input.tier;
  const config = getCareerInsightsPromptConfig(tier);
  const { promptVersion } = getInsightsConfig(tier);
  const prompt = promptForTier(tier);
  const completion = await openAiStructuredGateway.requestStructuredCompletion({
    feature: config.feature,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    jsonSchema: OUTPUT_SCHEMA,
    messages: [
      { role: 'system', content: prompt.system },
      {
        role: 'user',
        content: `${prompt.user}\n\nChart data JSON:\n${JSON.stringify(input.chartPayload)}`,
      },
    ],
    timeoutMs: config.timeoutMs,
  });

  const normalized = normalizeInsightsPayload(tier, completion.parsedContent);
  if (!normalized) {
    throw new Error('OpenAI insights payload format is invalid');
  }

  return {
    insights: normalized,
    model: config.model,
    promptVersion,
  };
}
