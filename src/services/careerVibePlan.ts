import { ObjectId } from 'mongodb';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import {
  getCollections,
  type AiSynergyDailyDoc,
  type CareerVibeDailyDoc,
  type CareerVibePlanContentDoc,
  type DailyTransitVibeDoc,
  type MongoCollections,
  type MorningBriefingPlanSnapshotDoc,
} from '../db/mongo.js';
import { getOrCreateDailyTransitForUser } from './dailyTransit.js';
import type { AiSynergyView } from './aiSynergy.js';
import { getCareerVibePlanPromptConfig } from './llmPromptRegistry.js';
import { REFLECTIVE_CAREER_GUIDANCE_PROMPT } from './llmPromptGuidance.js';
import {
  classifyLlmGenerationError,
  requestStructuredCompletionWithFallback,
  resolveBackupModel,
  type LlmGenerationFailureCode,
  type LlmNarrativeStatus,
} from './llmStructuredFallback.js';

export type CareerVibePlanTier = CareerVibeDailyDoc['tier'];
export type CareerVibePlanView = {
  dateKey: string;
  cached: boolean;
  schemaVersion: string;
  tier: CareerVibePlanTier;
  narrativeSource: 'llm' | null;
  narrativeStatus: LlmNarrativeStatus;
  narrativeFailureCode: LlmGenerationFailureCode | null;
  model: string;
  promptVersion: string;
  generatedAt: string;
  staleAfter: string;
  modeLabel: string;
  metrics: CareerVibeDailyDoc['metrics'];
  plan: CareerVibePlanContentDoc | null;
  explanation: CareerVibeDailyDoc['explanation'];
  sources: CareerVibeDailyDoc['sources'];
};

export type EnsureCareerVibePlanResult = {
  item: CareerVibePlanView;
  cached: boolean;
};
export type CareerVibePlanLlmMode = 'sync' | 'background' | 'off';

const CAREER_VIBE_PLAN_SCHEMA_VERSION = 'career-vibe-plan-v1';
const CAREER_VIBE_PENDING_RETRY_AFTER_MS = 60_000;
const CAREER_VIBE_SUMMARY_MIN_LENGTH = 90;
const CAREER_VIBE_SUMMARY_MAX_LENGTH = 180;

export function shouldReuseCachedCareerVibePlan(input: {
  doc: Pick<CareerVibeDailyDoc, 'narrativeStatus' | 'updatedAt'>;
  llmAllowed: boolean;
  llmMode: CareerVibePlanLlmMode;
  now: Date;
}) {
  if (input.doc.narrativeStatus !== 'pending') return true;
  if (!input.llmAllowed) return false;
  if (input.llmMode === 'sync') return false;
  const ageMs = input.now.getTime() - input.doc.updatedAt.getTime();
  return ageMs >= 0 && ageMs < CAREER_VIBE_PENDING_RETRY_AFTER_MS;
}

const CAREER_VIBE_PLAN_LLM_SYSTEM_PROMPT = [
  'You are a pragmatic career operating coach inside an astrology career app.',
  'You receive deterministic daily work metrics, transit drivers, and a draft plan.',
  'Rewrite the plan into practical, user-facing guidance for one work day.',
  REFLECTIVE_CAREER_GUIDANCE_PROMPT,
  'Do not change numeric metrics, dates, or the peak time window.',
  'Do not claim certainty or guaranteed outcomes.',
  'Avoid medical, legal, and financial advice.',
  'Output strict JSON only.',
].join(' ');

const CAREER_VIBE_PLAN_LLM_USER_PROMPT = [
  'Generate an actionable daily career plan.',
  'Requirements:',
  '- headline: 4..72 chars.',
  '- summary: exactly 2 sentences, 90..180 chars total, no line breaks; it must fit into a five-line mobile text block.',
  '- primaryAction: one concrete action, 20..140 chars.',
  '- bestFor: 2..4 short work categories.',
  '- avoid: 2..4 concrete traps to avoid.',
  '- focusStrategy, communicationStrategy, aiWorkStrategy, riskGuardrail: each 50..220 chars.',
  '- Keep tone direct, useful, and product-like.',
  '- Do not use emojis or mystical filler.',
].join('\n');

const CAREER_VIBE_PLAN_LLM_SCHEMA = {
  name: 'career_vibe_plan',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: [
      'headline',
      'summary',
      'primaryAction',
      'bestFor',
      'avoid',
      'focusStrategy',
      'communicationStrategy',
      'aiWorkStrategy',
      'riskGuardrail',
    ],
    properties: {
      headline: { type: 'string', minLength: 4, maxLength: 72 },
      summary: { type: 'string', minLength: CAREER_VIBE_SUMMARY_MIN_LENGTH, maxLength: CAREER_VIBE_SUMMARY_MAX_LENGTH },
      primaryAction: { type: 'string', minLength: 20, maxLength: 140 },
      bestFor: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: { type: 'string', minLength: 4, maxLength: 48 },
      },
      avoid: {
        type: 'array',
        minItems: 2,
        maxItems: 4,
        items: { type: 'string', minLength: 8, maxLength: 90 },
      },
      focusStrategy: { type: 'string', minLength: 50, maxLength: 220 },
      communicationStrategy: { type: 'string', minLength: 50, maxLength: 220 },
      aiWorkStrategy: { type: 'string', minLength: 50, maxLength: 220 },
      riskGuardrail: { type: 'string', minLength: 50, maxLength: 220 },
    },
  },
} as const;

type CareerVibeLlmPlan = Omit<CareerVibePlanContentDoc, 'peakWindow'>;

function clampScore(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildStaleAfter(dateKey: string, referenceBase: Date) {
  const midnightUtc = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc.getTime())) {
    return new Date(referenceBase.getTime() + 24 * 60 * 60 * 1000);
  }
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() + 1);
  return midnightUtc;
}

function deriveBaselineAiSynergyScore(metrics: { energy: number; focus: number; luck: number }) {
  const weighted = metrics.energy * 0.34 + metrics.focus * 0.44 + metrics.luck * 0.22;
  const coherenceBoost = (metrics.focus - metrics.energy) * 0.06;
  return clampScore(weighted + coherenceBoost);
}

function normalizeTextList(input: Array<string | null | undefined>, defaults: string[], limit: number) {
  const seen = new Set<string>();
  const values = [...input, ...defaults]
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .filter((entry) => {
      const key = entry.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return values.slice(0, limit);
}

function normalizeLlmString(input: unknown, minLength: number, maxLength: number) {
  if (typeof input !== 'string') return null;
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length < minLength || value.length > maxLength) return null;
  return value;
}

function normalizeLlmStringArray(input: unknown, minItems: number, maxItems: number, minLength: number, maxLength: number) {
  if (!Array.isArray(input)) return null;
  const normalized = input
    .map((entry) => normalizeLlmString(entry, minLength, maxLength))
    .filter((entry): entry is string => Boolean(entry))
    .slice(0, maxItems);
  return normalized.length >= minItems ? normalized : null;
}

export function normalizeCareerVibePlanFromLlm(raw: unknown): CareerVibeLlmPlan | null {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;
  const headline = normalizeLlmString(payload.headline, 4, 72);
  const summary = normalizeLlmString(payload.summary, CAREER_VIBE_SUMMARY_MIN_LENGTH, CAREER_VIBE_SUMMARY_MAX_LENGTH);
  const primaryAction = normalizeLlmString(payload.primaryAction, 20, 140);
  const bestFor = normalizeLlmStringArray(payload.bestFor, 2, 4, 4, 48);
  const avoid = normalizeLlmStringArray(payload.avoid, 2, 4, 8, 90);
  const focusStrategy = normalizeLlmString(payload.focusStrategy, 50, 220);
  const communicationStrategy = normalizeLlmString(payload.communicationStrategy, 50, 220);
  const aiWorkStrategy = normalizeLlmString(payload.aiWorkStrategy, 50, 220);
  const riskGuardrail = normalizeLlmString(payload.riskGuardrail, 50, 220);

  if (
    !headline ||
    !summary ||
    !primaryAction ||
    !bestFor ||
    !avoid ||
    !focusStrategy ||
    !communicationStrategy ||
    !aiWorkStrategy ||
    !riskGuardrail
  ) {
    return null;
  }

  return {
    headline,
    summary,
    primaryAction,
    bestFor,
    avoid,
    focusStrategy,
    communicationStrategy,
    aiWorkStrategy,
    riskGuardrail,
  };
}

function formatPeakWindow(metrics: { energy: number; focus: number; luck: number }, dateKey: string) {
  const daySeed = Number(dateKey.slice(-2)) || 11;
  const startHour24 = 9 + ((metrics.energy + metrics.focus + metrics.luck + daySeed) % 9);
  const endHour24 = Math.min(startHour24 + 2, 21);
  const to12Hour = (hour24: number) => {
    const hour = hour24 % 12;
    return hour === 0 ? '12' : String(hour);
  };
  return `${to12Hour(startHour24)}-${to12Hour(endHour24)} ${endHour24 >= 12 ? 'PM' : 'AM'}`;
}

function resolvePrimaryAction(metrics: CareerVibeDailyDoc['metrics']) {
  if (metrics.focus >= 76 && metrics.energy >= 70) {
    return 'Close one meaningful deliverable before opening new threads.';
  }
  if (metrics.aiSynergy >= 76 && metrics.focus >= 64) {
    return 'Use AI to turn one messy task into a reviewed draft.';
  }
  if (metrics.opportunity >= 74) {
    return 'Use the strongest timing window for outreach, negotiation, or follow-up.';
  }
  if (metrics.energy <= 54) {
    return 'Pick one contained task and protect recovery between work blocks.';
  }
  return 'Move one career priority forward with a tight, visible next step.';
}

function resolveBestFor(metrics: CareerVibeDailyDoc['metrics']) {
  return normalizeTextList(
    [
      metrics.focus >= 72 ? 'Deep work' : 'Planning',
      metrics.energy >= 72 ? 'Shipping decisions' : 'Steady execution',
      metrics.opportunity >= 70 ? 'Outreach' : 'Follow-through',
      metrics.aiSynergy >= 70 ? 'AI-assisted drafting' : 'Manual review',
    ],
    ['Prioritization', 'Focused delivery', 'Careful review'],
    4
  );
}

function resolveAvoid(metrics: CareerVibeDailyDoc['metrics']) {
  return normalizeTextList(
    [
      metrics.focus < 64 ? 'Switching between too many tools' : 'Breaking deep work with low-value pings',
      metrics.energy > 80 ? 'Rushing final approvals' : 'Letting small tasks consume the peak window',
      metrics.aiSynergy < 66 ? 'Delegating vague work to AI' : 'Accepting AI output without review',
      metrics.opportunity < 62 ? 'Forcing high-stakes outreach' : 'Leaving important follow-ups vague',
    ],
    ['Starting work without a checkpoint', 'Opening too many parallel threads'],
    4
  );
}

function resolveFocusStrategy(metrics: CareerVibeDailyDoc['metrics']) {
  if (metrics.focus >= 72) {
    return 'Put the hardest work in the first protected block, then use lighter admin work after the main deliverable is closed.';
  }
  return 'Keep the work surface narrow: define one output, one source of truth, and one review checkpoint before switching context.';
}

function resolveCommunicationStrategy(metrics: CareerVibeDailyDoc['metrics'], peakWindow: string) {
  if (metrics.opportunity >= 72) {
    return `Use ${peakWindow} for outreach, negotiation, or stakeholder updates while timing support is strongest.`;
  }
  return `Keep ${peakWindow} for low-friction follow-up and avoid forcing high-stakes conversations without a clear ask.`;
}

function resolveAiWorkStrategy(metrics: CareerVibeDailyDoc['metrics']) {
  if (metrics.aiSynergy >= 76) {
    return 'Use AI for structured drafting, option generation, and checklists, then reserve final judgement for a human review pass.';
  }
  return 'Keep AI tasks bounded: ask for outlines, comparisons, or cleanup, and avoid delegating ambiguous decisions without context.';
}

function resolveRiskGuardrail(metrics: CareerVibeDailyDoc['metrics'], transitVibe: DailyTransitVibeDoc) {
  const caution = transitVibe.cautions?.find((entry) => typeof entry === 'string' && entry.trim().length > 0);
  if (caution) return caution.trim();
  if (metrics.energy >= 80 && metrics.focus < 70) {
    return 'High drive can outrun precision today, so slow down before sharing decisions externally.';
  }
  return 'Close the loop with one explicit review checkpoint before expanding scope or starting another priority.';
}

function buildMetricNotes(metrics: CareerVibeDailyDoc['metrics']) {
  return [
    `Energy ${metrics.energy}% sets the capacity for execution and pace.`,
    `Focus ${metrics.focus}% indicates how much deep work the day can support.`,
    `Opportunity ${metrics.opportunity}% maps the timing quality for outreach and follow-through.`,
    `AI synergy ${metrics.aiSynergy}% shows how well structured AI collaboration fits today.`,
  ];
}

export function buildCareerVibePlanView(input: {
  dateKey: string;
  cached: boolean;
  tier: CareerVibePlanTier;
  generatedAt: Date;
  staleAfter: Date;
  transitVibe: DailyTransitVibeDoc;
  aiSynergy: AiSynergyView | null;
  sources: CareerVibeDailyDoc['sources'];
  narrativeStatus?: LlmNarrativeStatus;
  narrativeFailureCode?: LlmGenerationFailureCode | null;
}): CareerVibePlanView {
  const config = getCareerVibePlanPromptConfig();
  const metrics = {
    energy: clampScore(input.transitVibe.metrics.energy),
    focus: clampScore(input.transitVibe.metrics.focus),
    luck: clampScore(input.transitVibe.metrics.luck),
    opportunity: clampScore(input.transitVibe.metrics.luck),
    aiSynergy: clampScore(
      input.aiSynergy?.score ??
        deriveBaselineAiSynergyScore({
          energy: input.transitVibe.metrics.energy,
          focus: input.transitVibe.metrics.focus,
          luck: input.transitVibe.metrics.luck,
        })
    ),
  };
  const modeLabel = input.transitVibe.modeLabel;

  return {
    dateKey: input.dateKey,
    cached: input.cached,
    schemaVersion: CAREER_VIBE_PLAN_SCHEMA_VERSION,
    tier: input.tier,
    narrativeSource: null,
    narrativeStatus: input.narrativeStatus ?? 'pending',
    narrativeFailureCode: input.narrativeFailureCode ?? null,
    model: config.model,
    promptVersion: config.promptVersion,
    generatedAt: input.generatedAt.toISOString(),
    staleAfter: input.staleAfter.toISOString(),
    modeLabel,
    metrics,
    plan: null,
    explanation: {
      drivers: normalizeTextList(input.transitVibe.drivers ?? [], ['Daily transit metrics define the base work mode.'], 4),
      cautions: normalizeTextList(input.transitVibe.cautions ?? [], ['Keep review gates explicit before sharing work.'], 4),
      metricNotes: buildMetricNotes(metrics),
    },
    sources: input.sources,
  };
}

function buildCareerVibePlanDraft(input: {
  base: CareerVibePlanView;
  transitVibe: DailyTransitVibeDoc;
  aiSynergy: AiSynergyView | null;
}): CareerVibePlanContentDoc {
  const metrics = input.base.metrics;
  const peakWindow = formatPeakWindow(metrics, input.base.dateKey);
  const primaryAction = resolvePrimaryAction(metrics);
  const aiHeadline = input.aiSynergy?.narrativeStatus === 'ready' ? input.aiSynergy.headline?.trim() : null;
  const aiSummary = input.aiSynergy?.narrativeStatus === 'ready' ? input.aiSynergy.summary?.trim() : null;

  return {
    headline: aiHeadline || input.base.modeLabel,
    summary:
      aiSummary ||
      `Today favors ${input.base.modeLabel.toLowerCase()}. Use ${peakWindow} for focused work and close with one review checkpoint.`,
    primaryAction,
    bestFor: resolveBestFor(metrics),
    avoid: resolveAvoid(metrics),
    peakWindow,
    focusStrategy: resolveFocusStrategy(metrics),
    communicationStrategy: resolveCommunicationStrategy(metrics, peakWindow),
    aiWorkStrategy: resolveAiWorkStrategy(metrics),
    riskGuardrail: resolveRiskGuardrail(metrics, input.transitVibe),
  };
}

export function toMorningBriefingPlanSnapshot(plan: CareerVibePlanView): MorningBriefingPlanSnapshotDoc | null {
  if (!plan.plan) return null;
  return {
    headline: plan.plan.headline,
    summary: plan.plan.summary,
    primaryAction: plan.plan.primaryAction,
    peakWindow: plan.plan.peakWindow,
    riskGuardrail: plan.plan.riskGuardrail,
  };
}

async function maybeEnhanceCareerVibePlanWithLlm(
  base: CareerVibePlanView,
  context: {
    transitVibe: DailyTransitVibeDoc;
    aiSynergy: AiSynergyView | null;
  }
): Promise<CareerVibePlanView> {
  const config = getCareerVibePlanPromptConfig();
  const draftPlan = buildCareerVibePlanDraft({
    base,
    transitVibe: context.transitVibe,
    aiSynergy: context.aiSynergy,
  });
  const completion = await requestStructuredCompletionWithFallback({
    primaryEnabled: env.OPENAI_CAREER_VIBE_PLAN_ENABLED && base.tier === 'premium',
    backupModel: resolveBackupModel('career_vibe_plan'),
    request: {
      feature: config.feature,
      model: config.model,
      promptVersion: config.promptVersion,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
      jsonSchema: CAREER_VIBE_PLAN_LLM_SCHEMA,
      messages: [
        { role: 'system', content: CAREER_VIBE_PLAN_LLM_SYSTEM_PROMPT },
        {
          role: 'user',
          content: `${CAREER_VIBE_PLAN_LLM_USER_PROMPT}

Context JSON:
${JSON.stringify(
  {
    dateKey: base.dateKey,
    tier: base.tier,
    modeLabel: base.modeLabel,
    metrics: base.metrics,
    peakWindow: draftPlan.peakWindow,
    transit: {
      title: context.transitVibe.title,
      summary: context.transitVibe.summary,
      drivers: context.transitVibe.drivers ?? [],
      cautions: context.transitVibe.cautions ?? [],
      tags: context.transitVibe.tags ?? [],
    },
    aiSynergy: context.aiSynergy
      ? {
          score: context.aiSynergy.score,
          band: context.aiSynergy.band,
          narrativeStatus: context.aiSynergy.narrativeStatus,
          headline: context.aiSynergy.narrativeStatus === 'ready' ? context.aiSynergy.headline : null,
          summary: context.aiSynergy.narrativeStatus === 'ready' ? context.aiSynergy.summary : null,
          recommendations: context.aiSynergy.narrativeStatus === 'ready' ? context.aiSynergy.recommendations : [],
          drivers: context.aiSynergy.drivers,
          cautions: context.aiSynergy.cautions,
        }
      : null,
    planningDraft: draftPlan,
  },
  null,
  0
)}`,
        },
      ],
      timeoutMs: config.timeoutMs,
    },
  });

  const parsed = normalizeCareerVibePlanFromLlm(completion.completion.parsedContent);
  if (!parsed) {
    throw new Error('OpenAI career vibe plan payload format is invalid');
  }

  return {
    ...base,
    narrativeSource: 'llm',
    narrativeStatus: 'ready',
    narrativeFailureCode: null,
    model: completion.model,
    plan: {
      ...parsed,
      peakWindow: draftPlan.peakWindow,
    },
  };
}

function toView(doc: CareerVibeDailyDoc, cached: boolean): CareerVibePlanView {
  return {
    dateKey: doc.dateKey,
    cached,
    schemaVersion: doc.schemaVersion,
    tier: doc.tier,
    narrativeSource: doc.narrativeSource,
    narrativeStatus: doc.narrativeStatus,
    narrativeFailureCode: (doc.narrativeFailureCode as LlmGenerationFailureCode | undefined) ?? null,
    model: doc.model,
    promptVersion: doc.promptVersion,
    generatedAt: doc.generatedAt.toISOString(),
    staleAfter: doc.staleAfter.toISOString(),
    modeLabel: doc.modeLabel,
    metrics: doc.metrics,
    plan: doc.plan,
    explanation: doc.explanation,
    sources: doc.sources,
  };
}

function buildDoc(input: {
  userId: ObjectId;
  profileHash: string;
  view: CareerVibePlanView;
  now: Date;
}): CareerVibeDailyDoc {
  return {
    _id: new ObjectId(),
    userId: input.userId,
    profileHash: input.profileHash,
    dateKey: input.view.dateKey,
    schemaVersion: input.view.schemaVersion,
    tier: input.view.tier,
    model: input.view.model,
    promptVersion: input.view.promptVersion,
    narrativeSource: input.view.narrativeSource,
    narrativeStatus: input.view.narrativeStatus,
    narrativeFailureCode: input.view.narrativeFailureCode,
    modeLabel: input.view.modeLabel,
    metrics: input.view.metrics,
    plan: input.view.plan,
    explanation: input.view.explanation,
    sources: input.view.sources,
    generatedAt: new Date(input.view.generatedAt),
    staleAfter: new Date(input.view.staleAfter),
    createdAt: input.now,
    updatedAt: input.now,
  };
}

function shouldAttemptLlm(tier: CareerVibePlanTier, mode: CareerVibePlanLlmMode) {
  const backupConfigured = Boolean(env.LLM_BACKUP_API_KEY && env.LLM_BACKUP_BASE_URL && resolveBackupModel('career_vibe_plan'));
  return mode !== 'off' && tier === 'premium' && (
    (env.OPENAI_CAREER_VIBE_PLAN_ENABLED && Boolean(env.OPENAI_API_KEY)) ||
    backupConfigured
  );
}

function buildCareerVibePlanSet(doc: CareerVibeDailyDoc, now: Date) {
  return {
    schemaVersion: doc.schemaVersion,
    tier: doc.tier,
    model: doc.model,
    promptVersion: doc.promptVersion,
    narrativeSource: doc.narrativeSource,
    narrativeStatus: doc.narrativeStatus,
    narrativeFailureCode: doc.narrativeFailureCode ?? null,
    modeLabel: doc.modeLabel,
    metrics: doc.metrics,
    plan: doc.plan,
    explanation: doc.explanation,
    sources: doc.sources,
    generatedAt: doc.generatedAt,
    staleAfter: doc.staleAfter,
    updatedAt: now,
  };
}

async function persistCareerVibePlan(input: {
  collections: MongoCollections;
  filter: {
    userId: ObjectId;
    profileHash: string;
    dateKey: string;
    schemaVersion: string;
    tier: CareerVibePlanTier;
    promptVersion: string;
  };
  generatedDoc: CareerVibeDailyDoc;
  now: Date;
}) {
  return input.collections.careerVibeDaily.findOneAndUpdate(
    input.filter,
    {
      $set: buildCareerVibePlanSet(input.generatedDoc, input.now),
      $setOnInsert: {
        _id: input.generatedDoc._id,
        createdAt: input.now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );
}

function enhanceCareerVibePlanInBackground(input: {
  collections: MongoCollections;
  filter: {
    userId: ObjectId;
    profileHash: string;
    dateKey: string;
    schemaVersion: string;
    tier: CareerVibePlanTier;
    promptVersion: string;
  };
  profileHash: string;
  base: CareerVibePlanView;
  transitVibe: DailyTransitVibeDoc;
  aiSynergy: AiSynergyView | null;
  userId: ObjectId;
  logger: FastifyBaseLogger;
}) {
  void (async () => {
    try {
      const enhanced = await maybeEnhanceCareerVibePlanWithLlm(input.base, {
        transitVibe: input.transitVibe,
        aiSynergy: input.aiSynergy,
      });
      if (enhanced.narrativeSource !== 'llm') return;

      const now = new Date();
      const generatedDoc = buildDoc({
        userId: input.userId,
        profileHash: input.profileHash,
        view: enhanced,
        now,
      });

      await input.collections.careerVibeDaily.updateOne(
        {
          ...input.filter,
          narrativeStatus: { $ne: 'ready' },
        },
        {
          $set: buildCareerVibePlanSet(generatedDoc, now),
        }
      );
    } catch (error) {
      const code = classifyLlmGenerationError(error);
      const now = new Date();
      await input.collections.careerVibeDaily.updateOne(
        {
          ...input.filter,
          narrativeStatus: 'pending',
        },
        {
          $set: {
            narrativeStatus: code === 'llm_unavailable' || code === 'llm_unconfigured' ? 'unavailable' : 'failed',
            narrativeFailureCode: code,
            updatedAt: now,
          },
        }
      );
      input.logger.warn(
        { error, code, userId: input.userId.toHexString(), dateKey: input.base.dateKey },
        'career vibe plan background llm enhancement skipped'
      );
    }
  })();
}

export async function getOrCreateCareerVibePlanForUser(input: {
  userId: ObjectId;
  date: Date;
  tier: CareerVibePlanTier;
  logger: FastifyBaseLogger;
  refresh?: boolean;
  llmMode?: CareerVibePlanLlmMode;
  collections?: MongoCollections;
}): Promise<EnsureCareerVibePlanResult> {
  const collections = input.collections ?? (await getCollections());
  const profile = await collections.birthProfiles.findOne({ userId: input.userId });
  if (!profile) {
    throw new Error('Birth profile not found');
  }

  const dateKey = toDateKey(input.date);
  const config = getCareerVibePlanPromptConfig();
  const filter = {
    userId: input.userId,
    profileHash: profile.profileHash,
    dateKey,
    schemaVersion: CAREER_VIBE_PLAN_SCHEMA_VERSION,
    tier: input.tier,
    promptVersion: config.promptVersion,
  };
  const llmMode = input.llmMode ?? 'sync';
  const llmAllowed = shouldAttemptLlm(input.tier, llmMode);
  const now = new Date();

  if (!input.refresh) {
    const existing = await collections.careerVibeDaily.findOne(filter);
    if (existing && shouldReuseCachedCareerVibePlan({ doc: existing, llmAllowed, llmMode, now })) {
      return {
        item: toView(existing, true),
        cached: true,
      };
    }
  }

  const transit = await getOrCreateDailyTransitForUser(input.userId, input.date, input.logger, {
    aiSynergyMode: 'cache-only',
  });
  const base = buildCareerVibePlanView({
    dateKey,
    cached: false,
    tier: input.tier,
    generatedAt: now,
    staleAfter: buildStaleAfter(dateKey, now),
    transitVibe: transit.doc.vibe,
    aiSynergy: transit.aiSynergy,
    narrativeStatus: llmAllowed ? 'pending' : 'unavailable',
    narrativeFailureCode: llmAllowed ? null : 'llm_unavailable',
    sources: {
      dailyTransitDateKey: transit.doc.dateKey,
      aiSynergyDateKey: transit.aiSynergy?.dateKey ?? null,
      dailyVibeAlgorithmVersion: transit.doc.vibe.algorithmVersion,
      aiSynergyAlgorithmVersion: (transit.aiSynergy?.algorithmVersion as AiSynergyDailyDoc['algorithmVersion'] | undefined) ?? null,
    },
  });

  let plan = base;
  if (llmAllowed && llmMode === 'sync') {
    try {
      plan = await maybeEnhanceCareerVibePlanWithLlm(base, {
        transitVibe: transit.doc.vibe,
        aiSynergy: transit.aiSynergy,
      });
    } catch (error) {
      const code = classifyLlmGenerationError(error);
      input.logger.warn({ error, code, userId: input.userId.toHexString(), dateKey }, 'career vibe plan llm enhancement skipped');
      plan = {
        ...base,
        narrativeSource: null,
        narrativeStatus: code === 'llm_unavailable' || code === 'llm_unconfigured' ? 'unavailable' : 'failed',
        narrativeFailureCode: code,
        plan: null,
      };
    }
  }

  const generatedDoc = buildDoc({
    userId: input.userId,
    profileHash: profile.profileHash,
    view: plan,
    now,
  });

  const persisted = await persistCareerVibePlan({
    collections,
    filter,
    generatedDoc,
    now,
  });

  if (llmAllowed && llmMode === 'background' && plan.narrativeStatus === 'pending') {
    enhanceCareerVibePlanInBackground({
      collections,
      filter,
      profileHash: profile.profileHash,
      base,
      transitVibe: transit.doc.vibe,
      aiSynergy: transit.aiSynergy,
      userId: input.userId,
      logger: input.logger,
    });
  }

  if (!persisted) {
    return {
      item: toView(generatedDoc, false),
      cached: false,
    };
  }

  return {
    item: toView(persisted, false),
    cached: false,
  };
}
