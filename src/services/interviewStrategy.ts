import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import {
  getCollections,
  type InterviewStrategyAlgorithmVersion,
  type InterviewStrategyScoreBreakdownDoc,
  type InterviewStrategySettingsDoc,
  type InterviewStrategySlotDoc,
  type InterviewStrategySlotSource,
} from '../db/mongo.js';
import { buildTodayDate, getOrCreateDailyTransitForUser } from './dailyTransit.js';
import { openAiStructuredGateway } from './llmGateway.js';
import { getInterviewStrategyPromptConfig } from './llmPromptRegistry.js';

export const INTERVIEW_STRATEGY_ALGORITHM_VERSION: InterviewStrategyAlgorithmVersion = 'interview-strategy-v1';

export type InterviewStrategySettingsView = {
  enabled: boolean;
  timezoneIana: string;
  slotDurationMinutes: 30 | 45 | 60;
  allowedWeekdays: number[];
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  slotsPerWeek: number;
  autoFillConfirmedAt: string | null;
  autoFillStartAt: string | null;
  filledUntilDateKey: string | null;
  lastGeneratedAt: string | null;
  updatedAt: string | null;
  source: 'default' | 'saved';
};

export type InterviewStrategyScoreBreakdownView = InterviewStrategyScoreBreakdownDoc;

export type InterviewStrategySlotView = {
  id: string;
  weekKey: string;
  startAt: string;
  endAt: string;
  timezoneIana: string;
  score: number;
  explanation: string;
  breakdown: InterviewStrategyScoreBreakdownView;
};

export type InterviewStrategyWeekView = {
  weekKey: string;
  weekStartAt: string;
  slots: InterviewStrategySlotView[];
};

export type InterviewStrategyPlanView = {
  strategyId: string;
  algorithmVersion: InterviewStrategyAlgorithmVersion;
  generatedAt: string | null;
  timezoneIana: string;
  horizonDays: number;
  filledUntilDateKey: string | null;
  slots: InterviewStrategySlotView[];
  weeks: InterviewStrategyWeekView[];
};

export type InterviewStrategyGenerationResult = {
  generated: number;
  updated: number;
  skipped: number;
  dateRange: {
    fromDateKey: string;
    untilDateKey: string;
  };
  generatedAt: Date;
};

const DEFAULT_SETTINGS = {
  enabled: false,
  timezoneIana: 'America/New_York',
  slotDurationMinutes: 60 as const,
  allowedWeekdays: [1, 2, 3, 4, 5],
  workdayStartMinute: 540,
  workdayEndMinute: 1080,
  quietHoursStartMinute: 1290,
  quietHoursEndMinute: 480,
  slotsPerWeek: 5,
};

const INTERVIEW_STRATEGY_GOLD_SCORE = 80;
const INTERVIEW_STRATEGY_GREEN_SCORE = 90;

const GOLD_SLOT_FALLBACK_VARIANTS = [
  'Planetary currents are quietly supportive, making this window ideal for clear answers and steady confidence.',
  'The sky pattern leans cooperative here, so your communication can land with more ease and precision.',
  'This period carries a smooth cosmic rhythm that supports focused thinking and polished self-presentation.',
  'Astrological flow is favorable now, helping your message feel structured, calm, and convincing.',
  'Celestial momentum is balanced in this slot, which is great for interviews that need clarity and composure.',
  'The current transit texture supports practical optimism, making this a strong moment for first impressions.',
  'Planets align for clean mental flow in this window, especially for concise storytelling and quick responses.',
  'Cosmic signals are supportive around this time, favoring stable energy and confident professional tone.',
  'This interval has supportive sky geometry that helps you stay sharp, grounded, and articulate.',
  'The astrological backdrop is constructive here, giving your interview delivery a natural sense of timing.',
] as const;

const INTERVIEW_STRATEGY_LLM_SYSTEM_PROMPT = [
  'You are a concise career astrology assistant.',
  'You receive deterministic slot scores and transit context.',
  'Write one polished explanation for why this interview slot is favorable.',
  'No guarantees, no absolute claims, no medical/legal/financial advice.',
  'Do not change provided numbers.',
  'Output strict JSON only.',
].join(' ');

const INTERVIEW_STRATEGY_LLM_USER_PROMPT = [
  'Generate a short explanation for one interview slot.',
  'Requirements:',
  '- explanation: 80..320 chars.',
  '- Mention why this date/time window is favorable.',
  '- Keep tone elegant but practical.',
  '- Avoid mystic overload and avoid emojis.',
  '- 1-2 sentences only.',
].join('\n');

const INTERVIEW_STRATEGY_LLM_SCHEMA = {
  name: 'interview_strategy_slot_explanation',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['explanation'],
    properties: {
      explanation: { type: 'string', minLength: 80, maxLength: 320 },
    },
  },
} as const;

type GeneratedInterviewSlot = {
  slotId: string;
  dateKey: string;
  startAt: Date;
  endAt: Date;
  timezoneIana: string;
  score: number;
  explanation: string;
  breakdown: InterviewStrategyScoreBreakdownDoc;
};

type InterviewStrategyTransitPromptContext = {
  title: string;
  modeLabel: string;
  summary: string;
  dominant: {
    planet: string;
    sign: string;
    house: number;
    retrograde: boolean;
  };
  metrics: {
    energy: number;
    focus: number;
    luck: number;
  };
  signals: unknown;
  tags: unknown;
  drivers: unknown;
  cautions: unknown;
};

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type LocalDateParts = Pick<LocalDateTimeParts, 'year' | 'month' | 'day'>;

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getDateTimeFormatter(timezoneIana: string) {
  const cached = dateTimeFormatterCache.get(timezoneIana);
  if (cached) return cached;

  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezoneIana,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  dateTimeFormatterCache.set(timezoneIana, formatter);
  return formatter;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function seededUnit(seed: string) {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function pickBySeed(items: readonly string[], seed: string) {
  if (items.length === 0) return '';
  const index = Math.floor(seededUnit(seed) * items.length);
  const normalizedIndex = clamp(index, 0, items.length - 1);
  return items[normalizedIndex] ?? items[0] ?? '';
}

function parseJsonSafely(text: string) {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function localDateKey(parts: LocalDateParts) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function parseDateKey(dateKey: string): LocalDateParts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey.trim());
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

function shiftLocalDay(parts: LocalDateParts, deltaDays: number): LocalDateParts {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function daysBetweenDateKeys(fromDateKey: string, untilDateKey: string) {
  const fromParts = parseDateKey(fromDateKey);
  const untilParts = parseDateKey(untilDateKey);
  if (!fromParts || !untilParts) return 0;
  const fromTs = Date.UTC(fromParts.year, fromParts.month - 1, fromParts.day);
  const untilTs = Date.UTC(untilParts.year, untilParts.month - 1, untilParts.day);
  return Math.floor((untilTs - fromTs) / (24 * 60 * 60 * 1000));
}

function toLocalDateTimeParts(date: Date, timezoneIana: string): LocalDateTimeParts {
  const parts = getDateTimeFormatter(timezoneIana).formatToParts(date);
  const map = new Map(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.get('year')),
    month: Number(map.get('month')),
    day: Number(map.get('day')),
    hour: Number(map.get('hour')),
    minute: Number(map.get('minute')),
    second: Number(map.get('second')),
  };
}

function timezoneOffsetMs(date: Date, timezoneIana: string) {
  const local = toLocalDateTimeParts(date, timezoneIana);
  const representedUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second, 0);
  return representedUtc - date.getTime();
}

function localDateTimeToUtc(parts: LocalDateTimeParts, timezoneIana: string) {
  let utcTs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  for (let pass = 0; pass < 3; pass += 1) {
    const offset = timezoneOffsetMs(new Date(utcTs), timezoneIana);
    const nextTs = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0) - offset;
    if (Math.abs(nextTs - utcTs) < 1000) {
      utcTs = nextTs;
      break;
    }
    utcTs = nextTs;
  }
  return new Date(utcTs);
}

function startOfLocalDayNow(now: Date, timezoneIana: string) {
  const local = toLocalDateTimeParts(now, timezoneIana);
  return {
    year: local.year,
    month: local.month,
    day: local.day,
  } satisfies LocalDateParts;
}

function isValidIanaTimezone(timezoneIana: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezoneIana }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function normalizeWeekdays(values: number[]) {
  const unique = Array.from(
    new Set(
      values
        .map((value) => Math.trunc(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6)
    )
  ).sort((a, b) => a - b);
  return unique.length > 0 ? unique : [...DEFAULT_SETTINGS.allowedWeekdays];
}

function normalizeSlotDuration(value: number): 30 | 45 | 60 {
  if (value === 30 || value === 45 || value === 60) return value;
  return DEFAULT_SETTINGS.slotDurationMinutes;
}

function normalizeSettingsInput(input: {
  enabled: boolean;
  timezoneIana: string;
  slotDurationMinutes: number;
  allowedWeekdays: number[];
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  slotsPerWeek: number;
}) {
  const slotDurationMinutes = normalizeSlotDuration(input.slotDurationMinutes);
  const allowedWeekdays = normalizeWeekdays(input.allowedWeekdays);
  const workdayStartMinute = clamp(Math.trunc(input.workdayStartMinute), 0, 1439);
  let workdayEndMinute = clamp(Math.trunc(input.workdayEndMinute), 0, 1439);
  if (workdayEndMinute <= workdayStartMinute + slotDurationMinutes) {
    workdayEndMinute = clamp(workdayStartMinute + slotDurationMinutes + 60, slotDurationMinutes, 1439);
  }
  const quietHoursStartMinute = clamp(Math.trunc(input.quietHoursStartMinute), 0, 1439);
  const quietHoursEndMinute = clamp(Math.trunc(input.quietHoursEndMinute), 0, 1439);
  const slotsPerWeek = clamp(Math.trunc(input.slotsPerWeek), 1, 10);
  const timezoneIana = input.timezoneIana.trim();

  return {
    enabled: Boolean(input.enabled),
    timezoneIana: timezoneIana.length > 0 ? timezoneIana : DEFAULT_SETTINGS.timezoneIana,
    slotDurationMinutes,
    allowedWeekdays,
    workdayStartMinute,
    workdayEndMinute,
    quietHoursStartMinute,
    quietHoursEndMinute,
    slotsPerWeek,
  };
}

function toSettingsView(doc: InterviewStrategySettingsDoc | null): InterviewStrategySettingsView {
  if (!doc) {
    return {
      ...DEFAULT_SETTINGS,
      autoFillConfirmedAt: null,
      autoFillStartAt: null,
      filledUntilDateKey: null,
      lastGeneratedAt: null,
      updatedAt: null,
      source: 'default',
    };
  }

  return {
    enabled: doc.enabled,
    timezoneIana: doc.timezoneIana,
    slotDurationMinutes: doc.slotDurationMinutes,
    allowedWeekdays: doc.allowedWeekdays,
    workdayStartMinute: doc.workdayStartMinute,
    workdayEndMinute: doc.workdayEndMinute,
    quietHoursStartMinute: doc.quietHoursStartMinute,
    quietHoursEndMinute: doc.quietHoursEndMinute,
    slotsPerWeek: doc.slotsPerWeek,
    autoFillConfirmedAt: doc.autoFillConfirmedAt ? doc.autoFillConfirmedAt.toISOString() : null,
    autoFillStartAt: doc.autoFillStartAt ? doc.autoFillStartAt.toISOString() : null,
    filledUntilDateKey: doc.filledUntilDateKey ?? null,
    lastGeneratedAt: doc.lastGeneratedAt ? doc.lastGeneratedAt.toISOString() : null,
    updatedAt: doc.updatedAt.toISOString(),
    source: 'saved',
  };
}

function getWeekdayWeight(weekday: number) {
  switch (weekday) {
    case 1:
      return 72;
    case 2:
      return 78;
    case 3:
      return 83;
    case 4:
      return 80;
    case 5:
      return 68;
    case 6:
      return 52;
    case 0:
      return 48;
    default:
      return 60;
  }
}

function getHourWeight(hour: number) {
  switch (hour) {
    case 8:
      return 58;
    case 9:
      return 72;
    case 10:
      return 82;
    case 11:
      return 88;
    case 12:
      return 74;
    case 13:
      return 70;
    case 14:
      return 80;
    case 15:
      return 84;
    case 16:
      return 77;
    case 17:
      return 68;
    case 18:
      return 60;
    default:
      return 45;
  }
}

function rangesOverlap(startA: number, endA: number, startB: number, endB: number) {
  return startA < endB && endA > startB;
}

function slotTouchesQuietHours(slotStartMinute: number, slotEndMinute: number, settings: InterviewStrategySettingsDoc) {
  if (settings.quietHoursStartMinute === settings.quietHoursEndMinute) return false;
  if (settings.quietHoursStartMinute < settings.quietHoursEndMinute) {
    return rangesOverlap(
      slotStartMinute,
      slotEndMinute,
      settings.quietHoursStartMinute,
      settings.quietHoursEndMinute
    );
  }

  return (
    rangesOverlap(slotStartMinute, slotEndMinute, settings.quietHoursStartMinute, 1440) ||
    rangesOverlap(slotStartMinute, slotEndMinute, 0, settings.quietHoursEndMinute)
  );
}

function getMondayWeekKeyForDateKey(dateKey: string) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return dateKey;
  const utcDate = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day));
  const weekday = utcDate.getUTCDay();
  const daysFromMonday = (weekday + 6) % 7;
  utcDate.setUTCDate(utcDate.getUTCDate() - daysFromMonday);
  return `${utcDate.getUTCFullYear()}-${String(utcDate.getUTCMonth() + 1).padStart(2, '0')}-${String(
    utcDate.getUTCDate()
  ).padStart(2, '0')}`;
}

function buildExplanation(input: {
  dailyCareerScore: number;
  aiSynergyScore: number;
  weekdayWeight: number;
  hourWeight: number;
}) {
  const drivers: Array<{ score: number; label: string }> = [];

  if (input.dailyCareerScore >= 72) {
    drivers.push({ score: input.dailyCareerScore, label: 'strong daily career momentum' });
  }
  if (input.aiSynergyScore >= 72) {
    drivers.push({ score: input.aiSynergyScore, label: 'high AI synergy support' });
  }
  if (input.weekdayWeight >= 78) {
    drivers.push({ score: input.weekdayWeight, label: 'high-performing weekday window' });
  }
  if (input.hourWeight >= 80) {
    drivers.push({ score: input.hourWeight, label: 'peak interview hour quality' });
  }

  drivers.sort((a, b) => b.score - a.score);
  const core = drivers.slice(0, 2).map((item) => item.label).join(' + ');
  return core.length > 0 ? core : 'balanced window for focused interviews';
}

function buildGoldFallbackExplanation(input: {
  userId: ObjectId;
  dateKey: string;
  slotId: string;
}) {
  return pickBySeed(
    GOLD_SLOT_FALLBACK_VARIANTS,
    `${input.userId.toHexString()}:${input.dateKey}:${input.slotId}:gold-fallback`
  );
}

function buildSlotExplanation(input: {
  userId: ObjectId;
  dateKey: string;
  slotId: string;
  score: number;
  breakdown: InterviewStrategyScoreBreakdownDoc;
}) {
  if (input.score >= INTERVIEW_STRATEGY_GOLD_SCORE) {
    return buildGoldFallbackExplanation({
      userId: input.userId,
      dateKey: input.dateKey,
      slotId: input.slotId,
    });
  }

  return buildExplanation({
    dailyCareerScore: input.breakdown.dailyCareerScore,
    aiSynergyScore: input.breakdown.aiSynergyScore,
    weekdayWeight: input.breakdown.weekdayWeight,
    hourWeight: input.breakdown.hourWeight,
  });
}

export function normalizeInterviewStrategyExplanationFromLlm(raw: unknown) {
  if (!raw || typeof raw !== 'object') return null;
  const payload = raw as Record<string, unknown>;
  if (typeof payload.explanation !== 'string') return null;
  const explanation = payload.explanation.replace(/\s+/g, ' ').trim();
  if (explanation.length < 60) return null;
  return explanation;
}

function selectSlotsForLlmEnhancement(slots: GeneratedInterviewSlot[]) {
  if (slots.length === 0) return [] as GeneratedInterviewSlot[];

  const maxSlots = clamp(Math.trunc(env.INTERVIEW_STRATEGY_LLM_MAX_SLOTS), 1, 10);
  const minGreenSlots = clamp(Math.trunc(env.INTERVIEW_STRATEGY_LLM_MIN_GREEN_SLOTS), 0, 10);

  const sorted = [...slots].sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    return left.startAt.getTime() - right.startAt.getTime();
  });
  const greenSlots = sorted.filter((slot) => slot.score >= INTERVIEW_STRATEGY_GREEN_SCORE);
  const selected: GeneratedInterviewSlot[] = [];
  const selectedIds = new Set<string>();

  for (const slot of greenSlots) {
    if (selected.length >= maxSlots) break;
    selected.push(slot);
    selectedIds.add(slot.slotId);
  }

  if (greenSlots.length < minGreenSlots) {
    for (const slot of sorted) {
      if (selected.length >= maxSlots) break;
      if (selectedIds.has(slot.slotId)) continue;
      selected.push(slot);
      selectedIds.add(slot.slotId);
    }
  }

  return selected;
}

function dateFromDateKeyAtNoon(dateKey: string) {
  const parsed = parseDateKey(dateKey);
  if (!parsed) return null;
  return new Date(parsed.year, parsed.month - 1, parsed.day, 12, 0, 0, 0);
}

async function maybeLoadTransitPromptContext(input: {
  userId: ObjectId;
  dateKey: string;
  logger: FastifyBaseLogger;
  cache: Map<string, InterviewStrategyTransitPromptContext | null>;
}) {
  const cached = input.cache.get(input.dateKey);
  if (cached !== undefined) return cached;

  const transitDate = dateFromDateKeyAtNoon(input.dateKey);
  if (!transitDate) {
    input.cache.set(input.dateKey, null);
    return null;
  }

  try {
    const transit = await getOrCreateDailyTransitForUser(input.userId, transitDate, input.logger);
    const vibe = transit.doc.vibe;
    const context: InterviewStrategyTransitPromptContext = {
      title: vibe.title,
      modeLabel: vibe.modeLabel,
      summary: vibe.summary,
      dominant: vibe.dominant,
      metrics: vibe.metrics,
      signals: vibe.signals ?? null,
      tags: vibe.tags ?? [],
      drivers: vibe.drivers ?? [],
      cautions: vibe.cautions ?? [],
    };
    input.cache.set(input.dateKey, context);
    return context;
  } catch (error) {
    input.logger.warn(
      {
        error,
        userId: input.userId.toHexString(),
        dateKey: input.dateKey,
      },
      'interview strategy transit context unavailable'
    );
    input.cache.set(input.dateKey, null);
    return null;
  }
}

async function requestInterviewStrategyExplanationFromLlm(input: {
  slot: GeneratedInterviewSlot;
  transitContext: InterviewStrategyTransitPromptContext | null;
}) {
  const config = getInterviewStrategyPromptConfig();
  const { model, promptVersion } = config;
  const slotBand =
    input.slot.score >= INTERVIEW_STRATEGY_GREEN_SCORE
      ? 'green'
      : input.slot.score >= INTERVIEW_STRATEGY_GOLD_SCORE
        ? 'gold'
        : 'regular';

  const slotDateLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: input.slot.timezoneIana,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(input.slot.startAt);
  const slotStartLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: input.slot.timezoneIana,
    hour: 'numeric',
    minute: '2-digit',
  }).format(input.slot.startAt);
  const slotEndLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: input.slot.timezoneIana,
    hour: 'numeric',
    minute: '2-digit',
  }).format(input.slot.endAt);

  const completion = await openAiStructuredGateway.requestStructuredCompletion({
    feature: config.feature,
    model,
    temperature: config.temperature,
    maxTokens: config.maxTokens,
    jsonSchema: INTERVIEW_STRATEGY_LLM_SCHEMA,
    messages: [
      { role: 'system', content: INTERVIEW_STRATEGY_LLM_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `${INTERVIEW_STRATEGY_LLM_USER_PROMPT}

Context JSON:
${JSON.stringify(
  {
    promptVersion,
    slot: {
      dateKey: input.slot.dateKey,
      dateLabel: slotDateLabel,
      timeWindow: `${slotStartLabel} - ${slotEndLabel}`,
      timezoneIana: input.slot.timezoneIana,
      score: input.slot.score,
      band: slotBand,
      breakdown: input.slot.breakdown,
    },
    transit: input.transitContext,
    deterministicDraft: input.slot.explanation,
  },
  null,
  0
)}`,
      },
    ],
    timeoutMs: config.timeoutMs,
  });

  const parsed = normalizeInterviewStrategyExplanationFromLlm(completion.parsedContent);
  if (!parsed) {
    throw new Error('OpenAI interview strategy payload format is invalid');
  }

  return parsed;
}

async function maybeEnhanceSlotExplanationsWithLlm(input: {
  collections: Awaited<ReturnType<typeof getCollections>>;
  userId: ObjectId;
  slots: GeneratedInterviewSlot[];
  logger: FastifyBaseLogger;
}) {
  if (!env.OPENAI_INTERVIEW_STRATEGY_ENABLED) return 0;
  if (!env.OPENAI_API_KEY) return 0;

  const candidates = selectSlotsForLlmEnhancement(input.slots);
  if (candidates.length === 0) return 0;

  let enhanced = 0;
  const transitCache = new Map<string, InterviewStrategyTransitPromptContext | null>();

  for (const slot of candidates) {
    try {
      const transitContext = await maybeLoadTransitPromptContext({
        userId: input.userId,
        dateKey: slot.dateKey,
        logger: input.logger,
        cache: transitCache,
      });
      const nextExplanation = await requestInterviewStrategyExplanationFromLlm({
        slot,
        transitContext,
      });

      if (nextExplanation === slot.explanation) {
        continue;
      }

      const updateResult = await input.collections.interviewStrategySlots.updateOne(
        {
          userId: input.userId,
          slotId: slot.slotId,
        },
        {
          $set: {
            explanation: nextExplanation,
            updatedAt: new Date(),
          },
        }
      );

      if (updateResult.modifiedCount > 0) {
        slot.explanation = nextExplanation;
        enhanced += 1;
      }
    } catch (error) {
      input.logger.warn(
        {
          error,
          userId: input.userId.toHexString(),
          slotId: slot.slotId,
          dateKey: slot.dateKey,
        },
        'interview strategy llm explanation skipped'
      );
    }
  }

  return enhanced;
}

async function resolveBaselineScores(userId: ObjectId, logger: FastifyBaseLogger) {
  try {
    const transit = await getOrCreateDailyTransitForUser(userId, buildTodayDate(), logger);
    const dailyCareerScore = Math.round(
      (transit.doc.vibe.metrics.energy + transit.doc.vibe.metrics.focus + transit.doc.vibe.metrics.luck) / 3
    );
    const aiSynergyScore = transit.aiSynergy?.score ?? 60;
    return {
      dailyCareerScore: clamp(dailyCareerScore, 0, 100),
      aiSynergyScore: clamp(Math.round(aiSynergyScore), 0, 100),
    };
  } catch {
    return {
      dailyCareerScore: 67,
      aiSynergyScore: 63,
    };
  }
}

function toSlotView(doc: InterviewStrategySlotDoc): InterviewStrategySlotView {
  return {
    id: doc.slotId,
    weekKey: doc.weekKey,
    startAt: doc.startAt.toISOString(),
    endAt: doc.endAt.toISOString(),
    timezoneIana: doc.timezoneIana,
    score: doc.score,
    explanation: doc.explanation,
    breakdown: doc.breakdown,
  };
}

function buildWeeks(slots: InterviewStrategySlotView[], slotsPerWeek: number): InterviewStrategyWeekView[] {
  const byWeek = new Map<string, InterviewStrategySlotView[]>();
  for (const slot of slots) {
    const list = byWeek.get(slot.weekKey);
    if (list) {
      list.push(slot);
      continue;
    }
    byWeek.set(slot.weekKey, [slot]);
  }

  const weeks: InterviewStrategyWeekView[] = [];
  for (const [weekKey, weekSlots] of byWeek.entries()) {
    weekSlots.sort((left, right) => right.score - left.score || left.startAt.localeCompare(right.startAt));
    const weekStartParts = parseDateKey(weekKey);
    const weekStartAt =
      weekStartParts === null
        ? new Date().toISOString()
        : new Date(Date.UTC(weekStartParts.year, weekStartParts.month - 1, weekStartParts.day)).toISOString();
    weeks.push({
      weekKey,
      weekStartAt,
      slots: weekSlots.slice(0, slotsPerWeek),
    });
  }

  weeks.sort((left, right) => left.weekStartAt.localeCompare(right.weekStartAt));
  return weeks;
}

export async function getInterviewStrategySettingsDocForUser(userId: ObjectId) {
  const collections = await getCollections();
  return collections.interviewStrategySettings.findOne({ userId });
}

export async function getInterviewStrategySettingsForUser(userId: ObjectId): Promise<InterviewStrategySettingsView> {
  const doc = await getInterviewStrategySettingsDocForUser(userId);
  return toSettingsView(doc);
}

export async function upsertInterviewStrategySettingsForUser(input: {
  userId: ObjectId;
  enabled: boolean;
  timezoneIana: string;
  slotDurationMinutes: number;
  allowedWeekdays: number[];
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  slotsPerWeek: number;
}): Promise<InterviewStrategySettingsView> {
  const normalized = normalizeSettingsInput(input);
  if (!isValidIanaTimezone(normalized.timezoneIana)) {
    throw new Error('Invalid IANA timezone identifier');
  }

  const collections = await getCollections();
  const now = new Date();
  const existing = await collections.interviewStrategySettings.findOne({ userId: input.userId });
  const shouldConfirmNow = normalized.enabled && !existing?.autoFillConfirmedAt;
  const autoFillConfirmedAt = shouldConfirmNow ? now : (existing?.autoFillConfirmedAt ?? null);
  const autoFillStartAt = shouldConfirmNow ? now : (existing?.autoFillStartAt ?? null);

  await collections.interviewStrategySettings.updateOne(
    { userId: input.userId },
    {
      $set: {
        enabled: normalized.enabled,
        timezoneIana: normalized.timezoneIana,
        slotDurationMinutes: normalized.slotDurationMinutes,
        allowedWeekdays: normalized.allowedWeekdays,
        workdayStartMinute: normalized.workdayStartMinute,
        workdayEndMinute: normalized.workdayEndMinute,
        quietHoursStartMinute: normalized.quietHoursStartMinute,
        quietHoursEndMinute: normalized.quietHoursEndMinute,
        slotsPerWeek: normalized.slotsPerWeek,
        autoFillConfirmedAt,
        autoFillStartAt,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        filledUntilDateKey: null,
        lastGeneratedAt: null,
        createdAt: now,
      },
    },
    { upsert: true }
  );

  const saved = await collections.interviewStrategySettings.findOne({ userId: input.userId });
  return toSettingsView(saved);
}

async function generateSlotsForRange(input: {
  userId: ObjectId;
  settings: InterviewStrategySettingsDoc;
  fromDateKey: string;
  untilDateKey: string;
  source: InterviewStrategySlotSource;
  logger: FastifyBaseLogger;
}): Promise<InterviewStrategyGenerationResult> {
  const collections = await getCollections();
  const now = new Date();
  const fromParts = parseDateKey(input.fromDateKey);
  const untilParts = parseDateKey(input.untilDateKey);
  if (!fromParts || !untilParts) {
    throw new Error('Invalid date range for interview strategy generation');
  }

  const baseline = await resolveBaselineScores(input.userId, input.logger);
  let generated = 0;
  let updated = 0;
  let skipped = 0;
  const generatedSlots: GeneratedInterviewSlot[] = [];

  let cursor = { ...fromParts };
  while (daysBetweenDateKeys(localDateKey(cursor), localDateKey(untilParts)) >= 0) {
    const dateKey = localDateKey(cursor);
    const utcDate = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day));
    const weekday = utcDate.getUTCDay();
    if (!input.settings.allowedWeekdays.includes(weekday)) {
      cursor = shiftLocalDay(cursor, 1);
      continue;
    }

    const dailyCareerScore = clamp(
      Math.round(baseline.dailyCareerScore + (seededUnit(`${input.userId.toHexString()}:${dateKey}:daily-career`) - 0.5) * 24),
      0,
      100
    );
    const aiSynergyScore = clamp(
      Math.round(baseline.aiSynergyScore + (seededUnit(`${input.userId.toHexString()}:${dateKey}:ai-synergy`) - 0.5) * 18),
      0,
      100
    );
    const weekdayWeight = getWeekdayWeight(weekday);

    for (
      let minute = input.settings.workdayStartMinute;
      minute + input.settings.slotDurationMinutes <= input.settings.workdayEndMinute;
      minute += 30
    ) {
      const endMinute = minute + input.settings.slotDurationMinutes;
      if (slotTouchesQuietHours(minute, endMinute, input.settings)) {
        continue;
      }

      const hourWeight = getHourWeight(Math.floor(minute / 60));
      const conflictPenalty = 0;
      const scoreRaw = 0.4 * dailyCareerScore + 0.25 * aiSynergyScore + 0.2 * weekdayWeight + 0.15 * hourWeight;
      const score = clamp(Math.round(scoreRaw - conflictPenalty), 0, 100);
      if (score < env.INTERVIEW_STRATEGY_MIN_SCORE) {
        skipped += 1;
        continue;
      }

      const slotId = `${dateKey}:${String(minute).padStart(4, '0')}:${input.settings.slotDurationMinutes}`;
      const weekKey = getMondayWeekKeyForDateKey(dateKey);
      const startAt = localDateTimeToUtc(
        {
          year: cursor.year,
          month: cursor.month,
          day: cursor.day,
          hour: Math.floor(minute / 60),
          minute: minute % 60,
          second: 0,
        },
        input.settings.timezoneIana
      );
      const endAt = localDateTimeToUtc(
        {
          year: cursor.year,
          month: cursor.month,
          day: cursor.day,
          hour: Math.floor(endMinute / 60),
          minute: endMinute % 60,
          second: 0,
        },
        input.settings.timezoneIana
      );
      if (endAt.getTime() <= startAt.getTime()) {
        skipped += 1;
        continue;
      }

      const breakdown: InterviewStrategyScoreBreakdownDoc = {
        dailyCareerScore,
        aiSynergyScore,
        weekdayWeight,
        hourWeight,
        conflictPenalty,
      };
      const explanation = buildSlotExplanation({
        userId: input.userId,
        dateKey,
        slotId,
        score,
        breakdown,
      });

      const updateResult = await collections.interviewStrategySlots.updateOne(
        {
          userId: input.userId,
          slotId,
        },
        {
          $set: {
            dateKey,
            weekKey,
            startAt,
            endAt,
            timezoneIana: input.settings.timezoneIana,
            score,
            explanation,
            breakdown,
            algorithmVersion: INTERVIEW_STRATEGY_ALGORITHM_VERSION,
            source: input.source,
            updatedAt: now,
          },
          $setOnInsert: {
            _id: new ObjectId(),
            createdAt: now,
          },
        },
        { upsert: true }
      );

      if (updateResult.upsertedCount > 0) {
        generated += 1;
      } else if (updateResult.modifiedCount > 0) {
        updated += 1;
      } else {
        skipped += 1;
      }

      generatedSlots.push({
        slotId,
        dateKey,
        startAt,
        endAt,
        timezoneIana: input.settings.timezoneIana,
        score,
        explanation,
        breakdown,
      });
    }

    cursor = shiftLocalDay(cursor, 1);
  }

  const llmEnhancedCount = await maybeEnhanceSlotExplanationsWithLlm({
    collections,
    userId: input.userId,
    slots: generatedSlots,
    logger: input.logger,
  });
  updated += llmEnhancedCount;

  return {
    generated,
    updated,
    skipped,
    dateRange: {
      fromDateKey: input.fromDateKey,
      untilDateKey: input.untilDateKey,
    },
    generatedAt: now,
  };
}

export async function rebuildInterviewStrategyWindowForUser(input: {
  userId: ObjectId;
  logger: FastifyBaseLogger;
  now?: Date;
  source: InterviewStrategySlotSource;
  horizonDays?: number;
}) {
  const now = input.now ?? new Date();
  const collections = await getCollections();
  const settings = await collections.interviewStrategySettings.findOne({ userId: input.userId });
  if (!settings || !settings.enabled) {
    return null;
  }
  if (!settings.autoFillConfirmedAt || !settings.autoFillStartAt) {
    return null;
  }

  const todayParts = startOfLocalDayNow(now, settings.timezoneIana);
  const horizonDays = clamp(Math.trunc(input.horizonDays ?? env.INTERVIEW_STRATEGY_INITIAL_HORIZON_DAYS), 7, 90);
  const untilParts = shiftLocalDay(todayParts, horizonDays - 1);
  const fromDateKey = localDateKey(todayParts);
  const untilDateKey = localDateKey(untilParts);

  await collections.interviewStrategySlots.deleteMany({
    userId: input.userId,
    dateKey: { $gte: fromDateKey },
  });

  const generation = await generateSlotsForRange({
    userId: input.userId,
    settings,
    fromDateKey,
    untilDateKey,
    source: input.source,
    logger: input.logger,
  });

  await collections.interviewStrategySettings.updateOne(
    { userId: input.userId },
    {
      $set: {
        filledUntilDateKey: untilDateKey,
        lastGeneratedAt: generation.generatedAt,
        updatedAt: generation.generatedAt,
      },
    }
  );

  return generation;
}

export async function maybeRefillInterviewStrategyWindowForUser(input: {
  userId: ObjectId;
  logger: FastifyBaseLogger;
  now?: Date;
  source: InterviewStrategySlotSource;
  thresholdDays?: number;
  refillDays?: number;
  settingsDoc?: InterviewStrategySettingsDoc | null;
}) {
  const now = input.now ?? new Date();
  const collections = await getCollections();
  const settings =
    input.settingsDoc ??
    (await collections.interviewStrategySettings.findOne({ userId: input.userId }));
  if (!settings || !settings.enabled) {
    return { status: 'skipped' as const, reason: 'settings_disabled' as const };
  }
  if (!settings.autoFillConfirmedAt || !settings.autoFillStartAt) {
    return { status: 'skipped' as const, reason: 'autofill_not_confirmed' as const };
  }

  const todayDateKey = localDateKey(startOfLocalDayNow(now, settings.timezoneIana));
  if (!settings.filledUntilDateKey) {
    const initial = await rebuildInterviewStrategyWindowForUser({
      userId: input.userId,
      logger: input.logger,
      now,
      source: 'bootstrap',
    });
    return {
      status: 'generated' as const,
      reason: 'bootstrap',
      generation: initial,
    };
  }

  const thresholdDays = clamp(Math.trunc(input.thresholdDays ?? env.INTERVIEW_STRATEGY_REFILL_THRESHOLD_DAYS), 1, 45);
  const refillDays = clamp(Math.trunc(input.refillDays ?? env.INTERVIEW_STRATEGY_REFILL_DAYS), 1, 45);
  const daysRemaining = daysBetweenDateKeys(todayDateKey, settings.filledUntilDateKey);
  if (daysRemaining > thresholdDays) {
    return {
      status: 'skipped' as const,
      reason: 'enough_horizon',
      daysRemaining,
    };
  }

  const filledUntilParts = parseDateKey(settings.filledUntilDateKey);
  if (!filledUntilParts) {
    const reset = await rebuildInterviewStrategyWindowForUser({
      userId: input.userId,
      logger: input.logger,
      now,
      source: 'bootstrap',
    });
    return {
      status: 'generated' as const,
      reason: 'invalid_filled_until_rebuilt',
      generation: reset,
    };
  }

  const refillStart = shiftLocalDay(filledUntilParts, 1);
  const refillEnd = shiftLocalDay(refillStart, refillDays - 1);
  const fromDateKey = localDateKey(refillStart);
  const untilDateKey = localDateKey(refillEnd);
  const generation = await generateSlotsForRange({
    userId: input.userId,
    settings,
    fromDateKey,
    untilDateKey,
    source: input.source,
    logger: input.logger,
  });

  await collections.interviewStrategySettings.updateOne(
    { userId: input.userId },
    {
      $set: {
        filledUntilDateKey: untilDateKey,
        lastGeneratedAt: generation.generatedAt,
        updatedAt: generation.generatedAt,
      },
    }
  );

  return {
    status: 'generated' as const,
    reason: 'refilled',
    generation,
  };
}

export async function fetchInterviewStrategyPlanForUser(input: {
  userId: ObjectId;
  now?: Date;
  horizonDays?: number;
}) {
  const collections = await getCollections();
  const settingsDoc = await collections.interviewStrategySettings.findOne({ userId: input.userId });
  const settings = toSettingsView(settingsDoc);
  const now = input.now ?? new Date();
  const timezoneIana = settings.timezoneIana;
  const startDateKey = localDateKey(startOfLocalDayNow(now, timezoneIana));
  const horizonDays = clamp(Math.trunc(input.horizonDays ?? env.INTERVIEW_STRATEGY_INITIAL_HORIZON_DAYS), 7, 90);
  const endDateKey = localDateKey(shiftLocalDay(parseDateKey(startDateKey) ?? startOfLocalDayNow(now, timezoneIana), horizonDays - 1));

  const slotDocs = settingsDoc
    ? await collections.interviewStrategySlots
        .find({
          userId: input.userId,
          dateKey: {
            $gte: startDateKey,
            $lte: endDateKey,
          },
        })
        .sort({
          startAt: 1,
        })
        .toArray()
    : [];

  const slots = slotDocs.map((doc) => toSlotView(doc));
  const weeks = buildWeeks(slots, settings.slotsPerWeek);
  const flattened = weeks.flatMap((week) => week.slots);

  const strategyId = `${INTERVIEW_STRATEGY_ALGORITHM_VERSION}:${input.userId.toHexString()}:${settings.lastGeneratedAt ?? 'none'}`;
  const plan: InterviewStrategyPlanView = {
    strategyId,
    algorithmVersion: INTERVIEW_STRATEGY_ALGORITHM_VERSION,
    generatedAt: settings.lastGeneratedAt,
    timezoneIana: settings.timezoneIana,
    horizonDays,
    filledUntilDateKey: settings.filledUntilDateKey,
    slots: flattened,
    weeks,
  };

  return {
    enabled: settings.enabled,
    settings,
    plan,
  };
}
