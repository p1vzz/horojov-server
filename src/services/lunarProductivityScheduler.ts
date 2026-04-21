import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import {
  getCollections,
  type BurnoutAlertSeverity,
  type LunarProductivityImpactDirection,
  type LunarProductivitySettingsDoc,
  type MongoCollections,
} from '../db/mongo.js';
import { runWithConcurrency } from './asyncPool.js';
import { buildTodayDate, getOrCreateDailyTransitForUser } from './dailyTransit.js';
import {
  calculateLunarProductivityRisk,
  isLunarProductivityJobCurrentForTransit,
  resolveLunarProductivityImpactDirection,
  resolveLunarProductivityPushSeverity,
  resolveLunarProductivityTimingSignals,
  type LunarPhase,
  type LunarProductivityTimingSignals,
} from './lunarProductivity.js';
import { runWithSchedulerLock } from './schedulerLockPolicy.js';

const LUNAR_PRODUCTIVITY_COOLDOWN_HOURS = 20;
const MIN_LEAD_BEFORE_EVENT_MINUTES = 10;
const MIN_SCHEDULE_AHEAD_MINUTES = 5;
const DISPATCH_BATCH_SIZE = 50;
const PHASE_HOUR_WEIGHT = 0.5;
const WORKDAY_MID_HOUR_WEIGHT = 0.3;
const HOUSE_HOUR_WEIGHT = 0.2;

export const LUNAR_PRODUCTIVITY_SAMPLE_LOCAL_HOURS = [7, 9, 11, 13, 15, 17, 19, 21] as const;

const SEVERITY_LEAD_MINUTES: Record<BurnoutAlertSeverity, number> = {
  warn: 30,
  high: 55,
  critical: 80,
};

const LUNAR_PUSH_COPY: Record<
  LunarProductivityImpactDirection,
  Record<BurnoutAlertSeverity, { title: string; body: string }>
> = {
  supportive: {
    warn: {
      title: 'Start Your Priority Task Soon',
      body: 'A supportive focus window is opening. Use the next block for hard work before meetings or admin.',
    },
    high: {
      title: 'Protect Your Best Work Block',
      body: 'Focus conditions are unusually supportive soon. Put your hardest task first and keep interruptions out.',
    },
    critical: {
      title: 'Use Your Strongest Focus Window',
      body: 'Today\'s clearest work block is approaching. Start the task that needs your best thinking and guard it.',
    },
  },
  disruptive: {
    warn: {
      title: 'Protect Your Next Focus Block',
      body: 'A weaker focus stretch is coming. Finish one priority task now and push admin or chat later.',
    },
    high: {
      title: 'Finish Priority Work Early',
      body: 'Focus conditions are getting noisier. Close the main task now and avoid extra context switching.',
    },
    critical: {
      title: 'Shield Deep Work Now',
      body: 'A disruptive focus stretch is close. Stop adding new tasks, wrap the priority item, and leave recovery space.',
    },
  },
};

const PHASE_PEAK_HOURS: Record<LunarPhase, number> = {
  new_moon: 13,
  waxing_crescent: 15,
  first_quarter: 11,
  waxing_gibbous: 14,
  full_moon: 17,
  waning_gibbous: 15,
  last_quarter: 10,
  waning_crescent: 9,
};

const HOUSE_PEAK_HOURS: Record<number, number> = {
  1: 9,
  2: 10,
  3: 11,
  4: 12,
  5: 13,
  6: 14,
  7: 15,
  8: 16,
  9: 17,
  10: 18,
  11: 19,
  12: 20,
};

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type LunarHourlyDipScore = {
  hour: number;
  score: number;
};

type LunarWindowPrediction = {
  hour: number;
  predictedEventMinute: number;
  hourlyScores: LunarHourlyDipScore[];
};

type ScheduleResult =
  | {
      status: 'planned';
      scheduledAt: Date;
      predictedDipAt: Date;
      dateKey: string;
    }
  | {
      status: 'skip';
      reason: string;
      predictedDipAt: Date;
      dateKey: string;
    };

type PlanResult =
  | { status: 'planned'; meta?: Record<string, unknown> }
  | { status: 'skipped'; reason: string; meta?: Record<string, unknown> }
  | { status: 'already_planned'; meta?: Record<string, unknown> }
  | { status: 'already_sent'; meta?: Record<string, unknown> }
  | { status: 'failed'; reason: string; meta?: Record<string, unknown> };

const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

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

function localDateKey(parts: Pick<LocalDateTimeParts, 'year' | 'month' | 'day'>) {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function minuteOfDay(parts: Pick<LocalDateTimeParts, 'hour' | 'minute'>) {
  return parts.hour * 60 + parts.minute;
}

function shiftLocalDay(
  parts: Pick<LocalDateTimeParts, 'year' | 'month' | 'day'>,
  deltaDays: number,
): Pick<LocalDateTimeParts, 'year' | 'month' | 'day'> {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function applyMinuteWithOverflow(parts: LocalDateTimeParts, minuteValue: number): LocalDateTimeParts {
  const dayDelta = Math.floor(minuteValue / 1440);
  const normalizedMinute = ((minuteValue % 1440) + 1440) % 1440;
  const shiftedDate = shiftLocalDay(parts, dayDelta);
  return {
    year: shiftedDate.year,
    month: shiftedDate.month,
    day: shiftedDate.day,
    hour: Math.floor(normalizedMinute / 60),
    minute: normalizedMinute % 60,
    second: 0,
  };
}

function isInsideWrappedWindow(minuteValue: number, startMinute: number, endMinute: number) {
  if (startMinute === endMinute) return true;
  if (startMinute < endMinute) {
    return minuteValue >= startMinute && minuteValue < endMinute;
  }
  return minuteValue >= startMinute || minuteValue < endMinute;
}

function moveOutOfQuietWindow(
  candidate: LocalDateTimeParts,
  quietStartMinute: number,
  quietEndMinute: number,
) {
  const currentMinute = minuteOfDay(candidate);
  if (!isInsideWrappedWindow(currentMinute, quietStartMinute, quietEndMinute)) {
    return candidate;
  }

  if (quietStartMinute < quietEndMinute) {
    return applyMinuteWithOverflow(candidate, quietEndMinute + 15);
  }

  if (currentMinute >= quietStartMinute) {
    return applyMinuteWithOverflow(candidate, quietEndMinute + 15 + 1440);
  }

  return applyMinuteWithOverflow(candidate, quietEndMinute + 15);
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

function resolveWorkdayMidHour(settings: Pick<LunarProductivitySettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>) {
  return (settings.workdayStartMinute + settings.workdayEndMinute) / 120;
}

function resolveMomentumHourShift(timingSignals: LunarProductivityTimingSignals) {
  if (timingSignals.momentum.focus <= -6) return -2;
  if (timingSignals.momentum.focus <= -2) return -1;
  if (timingSignals.momentum.focus >= 5) return 1;
  return 0;
}

function resolveAspectHourShift(timingSignals: LunarProductivityTimingSignals) {
  let shift = 0;
  if (timingSignals.moonSaturnHard >= 0.7) shift += 1;
  if (timingSignals.moonMercuryHard >= 0.7) shift -= 1;
  return shift;
}

function resolveTargetDipHour(input: {
  settings: Pick<LunarProductivitySettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>;
  timingSignals: LunarProductivityTimingSignals;
}) {
  const phasePeakHour = PHASE_PEAK_HOURS[input.timingSignals.moonPhase];
  const workdayMidHour = resolveWorkdayMidHour(input.settings);
  const housePeakHour = input.timingSignals.moonHouse
    ? (HOUSE_PEAK_HOURS[input.timingSignals.moonHouse] ?? workdayMidHour)
    : workdayMidHour;
  const shiftedHour =
    phasePeakHour * PHASE_HOUR_WEIGHT +
    workdayMidHour * WORKDAY_MID_HOUR_WEIGHT +
    housePeakHour * HOUSE_HOUR_WEIGHT +
    resolveMomentumHourShift(input.timingSignals) +
    resolveAspectHourShift(input.timingSignals);

  return clamp(Math.round(shiftedHour), 7, 21);
}

function resolvePhaseIntensity(timingSignals: LunarProductivityTimingSignals) {
  const illuminationBias = Math.abs(timingSignals.illuminationPercent - 50) / 50;
  const phaseBias =
    timingSignals.moonPhase === 'full_moon'
      ? 0.4
      : timingSignals.moonPhase === 'new_moon'
        ? 0.32
        : timingSignals.moonPhase === 'first_quarter' || timingSignals.moonPhase === 'last_quarter'
          ? 0.24
          : 0.14;
  return clamp(illuminationBias + phaseBias, 0.2, 1.6);
}

export function estimateLunarHourlyDipScores(input: {
  riskScore: number;
  settings: Pick<LunarProductivitySettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>;
  timingSignals: LunarProductivityTimingSignals;
}) {
  const targetHour = resolveTargetDipHour(input);
  const phaseIntensity = resolvePhaseIntensity(input.timingSignals);

  return LUNAR_PRODUCTIVITY_SAMPLE_LOCAL_HOURS.map((hour) => {
    const distance = Math.abs(hour - targetHour);
    const hourAlignment = clamp(1 - distance / 8, 0.2, 1);
    const supportiveAlignment = clamp(1 - Math.abs(hour - (targetHour - 1)) / 10, 0.25, 1);
    const supportiveFactor = input.timingSignals.supportiveAspectStrength / 12;
    const score = clamp(
      input.riskScore * 0.54 +
        input.timingSignals.moonHardCount * 8 * hourAlignment +
        input.timingSignals.moonSaturnHard * 10 * hourAlignment +
        input.timingSignals.moonMercuryHard *
          7 *
          clamp(1 - Math.abs(hour - (targetHour - 1)) / 8, 0.2, 1) +
        phaseIntensity * 2 -
        supportiveFactor * 4 * supportiveAlignment,
      0,
      100,
    );

    return {
      hour,
      score: Number(score.toFixed(2)),
    } satisfies LunarHourlyDipScore;
  });
}

export function resolveLunarPredictedWindowLocalMinute(input: {
  riskScore: number;
  settings: Pick<LunarProductivitySettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>;
  timingSignals: LunarProductivityTimingSignals;
  impactDirection: LunarProductivityImpactDirection;
}): LunarWindowPrediction {
  const hourlyScores = estimateLunarHourlyDipScores(input);
  let best = hourlyScores[0];

  for (const candidate of hourlyScores.slice(1)) {
    const isBetter =
      input.impactDirection === 'supportive'
        ? candidate.score < (best?.score ?? Number.POSITIVE_INFINITY)
        : candidate.score > (best?.score ?? Number.NEGATIVE_INFINITY);
    if (isBetter || (candidate.score === best?.score && candidate.hour < best.hour)) {
      best = candidate;
    }
  }

  return {
    hour: best?.hour ?? LUNAR_PRODUCTIVITY_SAMPLE_LOCAL_HOURS[0],
    predictedEventMinute: (best?.hour ?? LUNAR_PRODUCTIVITY_SAMPLE_LOCAL_HOURS[0]) * 60 + 20,
    hourlyScores,
  };
}

export function resolveLunarPredictedDipLocalMinute(input: {
  riskScore: number;
  settings: Pick<LunarProductivitySettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>;
  timingSignals: LunarProductivityTimingSignals;
}) {
  const predictedWindow = resolveLunarPredictedWindowLocalMinute({
    ...input,
    impactDirection: 'disruptive',
  });

  return {
    dipHour: predictedWindow.hour,
    predictedDipMinute: predictedWindow.predictedEventMinute,
    hourlyScores: predictedWindow.hourlyScores,
  };
}

export function computeLunarScheduleFromPredictedEventMinute(input: {
  now: Date;
  settings: LunarProductivitySettingsDoc;
  severity: BurnoutAlertSeverity;
  predictedEventMinute: number;
}): ScheduleResult {
  const { now, settings, severity, predictedEventMinute } = input;
  const leadMinutes = SEVERITY_LEAD_MINUTES[severity];
  const todayLocal = toLocalDateTimeParts(now, settings.timezoneIana);
  const todayDateKey = localDateKey(todayLocal);
  const predictedDipLocal = applyMinuteWithOverflow(todayLocal, predictedEventMinute);
  const predictedDipAt = localDateTimeToUtc(predictedDipLocal, settings.timezoneIana);

  let candidateLocal = applyMinuteWithOverflow(todayLocal, predictedEventMinute - leadMinutes);
  candidateLocal = moveOutOfQuietWindow(
    candidateLocal,
    settings.quietHoursStartMinute,
    settings.quietHoursEndMinute,
  );

  if (localDateKey(candidateLocal) !== todayDateKey) {
    return {
      status: 'skip',
      reason: 'candidate moved outside local day',
      predictedDipAt,
      dateKey: todayDateKey,
    };
  }

  const candidateMinute = minuteOfDay(candidateLocal);
  if (candidateMinute < settings.workdayStartMinute) {
    candidateLocal = applyMinuteWithOverflow(candidateLocal, settings.workdayStartMinute);
  } else if (candidateMinute > settings.workdayEndMinute) {
    candidateLocal = applyMinuteWithOverflow(candidateLocal, settings.workdayEndMinute);
  }

  if (localDateKey(candidateLocal) !== todayDateKey) {
    return {
      status: 'skip',
      reason: 'workday clamp moved candidate outside local day',
      predictedDipAt,
      dateKey: todayDateKey,
    };
  }

  let scheduledAt = localDateTimeToUtc(candidateLocal, settings.timezoneIana);
  const latestAllowedAt = predictedDipAt.getTime() - MIN_LEAD_BEFORE_EVENT_MINUTES * 60_000;
  const minScheduleAt = new Date(now.getTime() + MIN_SCHEDULE_AHEAD_MINUTES * 60_000);

  if (scheduledAt.getTime() < minScheduleAt.getTime()) {
    if (minScheduleAt.getTime() > latestAllowedAt) {
      return {
        status: 'skip',
        reason: 'minimum schedule window is later than allowed lead',
        predictedDipAt,
        dateKey: todayDateKey,
      };
    }
    scheduledAt = minScheduleAt;
  }

  if (scheduledAt.getTime() > latestAllowedAt) {
    return {
      status: 'skip',
      reason: 'candidate violates dip lead constraint',
      predictedDipAt,
      dateKey: todayDateKey,
    };
  }

  return {
    status: 'planned',
    scheduledAt,
    predictedDipAt,
    dateKey: todayDateKey,
  };
}

export function computeLunarScheduleFromPredictedDipMinute(input: {
  now: Date;
  settings: LunarProductivitySettingsDoc;
  severity: BurnoutAlertSeverity;
  predictedDipMinute: number;
}) {
  return computeLunarScheduleFromPredictedEventMinute({
    ...input,
    predictedEventMinute: input.predictedDipMinute,
  });
}

export function shouldStartLunarProductivityScheduler(input: {
  enabled: boolean;
  expoPushAccessToken: string;
}) {
  return input.enabled && input.expoPushAccessToken.trim().length > 0;
}

function isDeviceNotRegistered(details: unknown) {
  if (!details || typeof details !== 'object') return false;
  const detailsRecord = details as Record<string, unknown>;
  const errorCode = detailsRecord.error;
  return typeof errorCode === 'string' && errorCode === 'DeviceNotRegistered';
}

async function sendExpoLunarProductivityPush(input: {
  token: string;
  severity: BurnoutAlertSeverity;
  impactDirection: LunarProductivityImpactDirection;
  dateKey: string;
  riskScore: number;
}) {
  const copy = LUNAR_PUSH_COPY[input.impactDirection][input.severity];
  const payload = [
    {
      to: input.token,
      title: copy.title,
      body: copy.body,
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data: {
        type: 'lunar_productivity_alert',
        impactDirection: input.impactDirection,
        severity: input.severity,
        dateKey: input.dateKey,
        riskScore: input.riskScore,
      },
    },
  ];

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  if (env.EFFECTIVE_EXPO_PUSH_ACCESS_TOKEN) {
    headers.Authorization = `Bearer ${env.EFFECTIVE_EXPO_PUSH_ACCESS_TOKEN}`;
  }

  const response = await fetch('https://exp.host/--/api/v2/push/send', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(12_000),
  });

  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    return {
      ok: false as const,
      error: `expo push request failed with status ${response.status}`,
      raw: typeof text === 'string' ? text.slice(0, 400) : null,
      deviceNotRegistered: false,
    };
  }

  const root = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  const dataNode = root?.data;
  const firstResult = Array.isArray(dataNode) ? dataNode[0] : dataNode;

  if (!firstResult || typeof firstResult !== 'object') {
    return {
      ok: false as const,
      error: 'expo push response is missing data',
      raw: typeof text === 'string' ? text.slice(0, 400) : null,
      deviceNotRegistered: false,
    };
  }

  const resultRecord = firstResult as Record<string, unknown>;
  const status = resultRecord.status;
  if (status === 'ok') {
    return {
      ok: true as const,
      messageId: typeof resultRecord.id === 'string' ? resultRecord.id : null,
    };
  }

  const details = resultRecord.details;
  const message =
    (typeof resultRecord.message === 'string' && resultRecord.message) ||
    (typeof resultRecord.error === 'string' && resultRecord.error) ||
    'expo push returned non-ok status';

  return {
    ok: false as const,
    error: message,
    raw: typeof text === 'string' ? text.slice(0, 400) : null,
    deviceNotRegistered: isDeviceNotRegistered(details),
  };
}

function toIsoOrNull(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

function resolveEffectiveSubscriptionTier(input: 'free' | 'premium' | undefined) {
  if (env.DEV_FORCE_PREMIUM_FOR_ALL_USERS) return 'premium' as const;
  return input === 'premium' ? 'premium' : 'free';
}

async function markCurrentDayPlanCancelled(input: {
  collections: MongoCollections;
  userId: ObjectId;
  dateKey: string;
  now: Date;
  reason: string;
}) {
  await input.collections.lunarProductivityJobs.updateOne(
    {
      userId: input.userId,
      dateKey: input.dateKey,
      status: 'planned',
    },
    {
      $set: {
        status: 'cancelled',
        scheduledAt: null,
        lastError: input.reason,
        updatedAt: input.now,
      },
    },
  );
}

async function upsertSkippedJob(input: {
  collections: MongoCollections;
  userId: ObjectId;
  profileHash: string;
  dateKey: string;
  now: Date;
  severity: BurnoutAlertSeverity;
  riskScore: number;
  impactDirection: LunarProductivityImpactDirection;
  predictedDipAt: Date;
  reason: string;
}) {
  await input.collections.lunarProductivityJobs.updateOne(
    { userId: input.userId, dateKey: input.dateKey },
    {
      $set: {
        profileHash: input.profileHash,
        severity: input.severity,
        riskScore: input.riskScore,
        impactDirection: input.impactDirection,
        predictedDipAt: input.predictedDipAt,
        scheduledAt: null,
        status: 'skipped',
        providerMessageId: null,
        sentAt: null,
        lastError: input.reason,
        updatedAt: input.now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: input.now,
      },
    },
    { upsert: true },
  );
}

async function planLunarProductivityAlertForUser(
  settings: LunarProductivitySettingsDoc,
  now: Date,
  logger: FastifyBaseLogger,
  collections: MongoCollections,
  subscriptionTier: 'free' | 'premium' | undefined,
  hasActivePushToken: boolean,
  recentSentAt: Date | null,
): Promise<PlanResult> {
  const effectiveTier = resolveEffectiveSubscriptionTier(subscriptionTier);
  if (effectiveTier !== 'premium') {
    return {
      status: 'skipped',
      reason: 'premium is required',
      meta: {
        subscriptionTier: subscriptionTier ?? null,
        effectiveTier,
      },
    };
  }

  let transit;
  try {
    transit = await getOrCreateDailyTransitForUser(settings.userId, buildTodayDate(), logger, {
      includeAiSynergy: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'daily transit build failed';
    if (message.includes('Birth profile not found')) {
      return {
        status: 'skipped',
        reason: 'birth profile is required',
      };
    }
    throw error;
  }

  const risk = calculateLunarProductivityRisk(transit.doc);
  const timingSignals = resolveLunarProductivityTimingSignals(transit.doc);
  const effectiveRiskScore = risk.riskScore;
  const impactDirection = resolveLunarProductivityImpactDirection(effectiveRiskScore);
  const effectiveSeverity = resolveLunarProductivityPushSeverity({
    riskScore: effectiveRiskScore,
    riskSeverity: risk.severity,
  });
  const dateKey = transit.doc.dateKey;
  const latestJob = await collections.lunarProductivityJobs.findOne(
    { userId: settings.userId, dateKey },
    {
      projection: {
        status: 1,
        sentAt: 1,
        scheduledAt: 1,
        severity: 1,
        riskScore: 1,
        impactDirection: 1,
        seenAt: 1,
        profileHash: 1,
        updatedAt: 1,
      },
    },
  );
  const existingJob = isLunarProductivityJobCurrentForTransit(latestJob, transit.doc) ? latestJob : null;

  if (!impactDirection || !effectiveSeverity) {
    await markCurrentDayPlanCancelled({
      collections,
      userId: settings.userId,
      dateKey,
      now,
      reason: 'impact outside configured thresholds',
    });
    return {
      status: 'skipped',
      reason: 'impact outside configured thresholds',
      meta: {
        dateKey,
        riskScore: effectiveRiskScore,
        riskSeverity: risk.severity,
        lowImpactThreshold: env.LUNAR_PRODUCTIVITY_LOW_IMPACT_THRESHOLD,
        highImpactThreshold: env.LUNAR_PRODUCTIVITY_HIGH_IMPACT_THRESHOLD,
      },
    };
  }

  if (latestJob?.status === 'sent') {
    return {
      status: 'already_sent',
      meta: {
        dateKey,
        sentAt: toIsoOrNull(latestJob.sentAt),
        severity: latestJob.severity,
        riskScore: latestJob.riskScore,
      },
    };
  }

  if (existingJob?.seenAt) {
    return {
      status: 'skipped',
      reason: 'viewed in app',
      meta: {
        dateKey,
        severity: existingJob.severity,
        riskScore: existingJob.riskScore,
        impactDirection: existingJob.impactDirection ?? impactDirection,
        seenAt: existingJob.seenAt.toISOString(),
      },
    };
  }

  if (existingJob?.status === 'planned') {
    return {
      status: 'already_planned',
      meta: {
        dateKey,
        scheduledAt: toIsoOrNull(existingJob.scheduledAt),
        severity: existingJob.severity,
        riskScore: existingJob.riskScore,
        impactDirection: existingJob.impactDirection ?? impactDirection,
      },
    };
  }

  const predictedWindow = resolveLunarPredictedWindowLocalMinute({
    riskScore: effectiveRiskScore,
    settings,
    timingSignals,
    impactDirection,
  });
  const schedule = computeLunarScheduleFromPredictedEventMinute({
    now,
    settings,
    severity: effectiveSeverity,
    predictedEventMinute: predictedWindow.predictedEventMinute,
  });

  if (recentSentAt) {
    await upsertSkippedJob({
      collections,
      userId: settings.userId,
      profileHash: transit.doc.profileHash,
      dateKey,
      now,
      severity: effectiveSeverity,
      riskScore: effectiveRiskScore,
      impactDirection,
      predictedDipAt: schedule.predictedDipAt,
      reason: 'cooldown active',
    });
    return {
      status: 'skipped',
      reason: 'cooldown active',
      meta: {
        dateKey,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        impactDirection,
        recentSentAt: toIsoOrNull(recentSentAt),
      },
    };
  }

  if (!hasActivePushToken) {
    await upsertSkippedJob({
      collections,
      userId: settings.userId,
      profileHash: transit.doc.profileHash,
      dateKey,
      now,
      severity: effectiveSeverity,
      riskScore: effectiveRiskScore,
      impactDirection,
      predictedDipAt: schedule.predictedDipAt,
      reason: 'active push token is missing',
    });
    return {
      status: 'skipped',
      reason: 'active push token is missing',
      meta: {
        dateKey,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        impactDirection,
      },
    };
  }

  if (schedule.status === 'skip') {
    await upsertSkippedJob({
      collections,
      userId: settings.userId,
      profileHash: transit.doc.profileHash,
      dateKey,
      now,
      severity: effectiveSeverity,
      riskScore: effectiveRiskScore,
      impactDirection,
      predictedDipAt: schedule.predictedDipAt,
      reason: schedule.reason,
    });
    return {
      status: 'skipped',
      reason: schedule.reason,
      meta: {
        dateKey,
        timezoneIana: settings.timezoneIana,
        workdayStartMinute: settings.workdayStartMinute,
        workdayEndMinute: settings.workdayEndMinute,
        quietHoursStartMinute: settings.quietHoursStartMinute,
        quietHoursEndMinute: settings.quietHoursEndMinute,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        impactDirection,
        predictedDipAt: schedule.predictedDipAt.toISOString(),
        hourlyScores: predictedWindow.hourlyScores,
      },
    };
  }

  await collections.lunarProductivityJobs.updateOne(
    { userId: settings.userId, dateKey },
    {
      $set: {
        profileHash: transit.doc.profileHash,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        impactDirection,
        predictedDipAt: schedule.predictedDipAt,
        scheduledAt: schedule.scheduledAt,
        status: 'planned',
        providerMessageId: null,
        sentAt: null,
        lastError: null,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true },
  );

  return {
    status: 'planned',
    meta: {
      dateKey,
      severity: effectiveSeverity,
      riskScore: effectiveRiskScore,
      impactDirection,
      scheduledAt: schedule.scheduledAt.toISOString(),
      predictedDipAt: schedule.predictedDipAt.toISOString(),
      hourlyScores: predictedWindow.hourlyScores,
    },
  };
}

async function runPlanningPass(logger: FastifyBaseLogger) {
  const now = new Date();
  const collections = await getCollections();
  const settingsDocs = await collections.lunarProductivitySettings
    .find(
      { enabled: true },
      {
        projection: {
          _id: 1,
          userId: 1,
          enabled: 1,
          timezoneIana: 1,
          workdayStartMinute: 1,
          workdayEndMinute: 1,
          quietHoursStartMinute: 1,
          quietHoursEndMinute: 1,
          createdAt: 1,
          updatedAt: 1,
        },
      },
    )
    .toArray();
  const userIds = settingsDocs.map((settings) => settings.userId);
  const cooldownBoundary = new Date(now.getTime() - LUNAR_PRODUCTIVITY_COOLDOWN_HOURS * 60 * 60 * 1000);
  const [users, activeTokenUsers, recentSentUsers] = userIds.length
    ? await Promise.all([
        collections.users.find({ _id: { $in: userIds } }, { projection: { _id: 1, subscriptionTier: 1 } }).toArray(),
        collections.pushNotificationTokens
          .aggregate<{ _id: ObjectId }>([
            {
              $match: {
                userId: { $in: userIds },
                active: true,
              },
            },
            {
              $group: {
                _id: '$userId',
              },
            },
          ])
          .toArray(),
        collections.lunarProductivityJobs
          .aggregate<{ _id: ObjectId; sentAt: Date | null }>([
            {
              $match: {
                userId: { $in: userIds },
                status: 'sent',
                sentAt: { $gte: cooldownBoundary },
              },
            },
            {
              $sort: {
                userId: 1,
                sentAt: -1,
              },
            },
            {
              $group: {
                _id: '$userId',
                sentAt: { $first: '$sentAt' },
              },
            },
          ])
          .toArray(),
      ])
    : [[], [], []];
  const subscriptionTierByUserId = new Map(users.map((user) => [user._id.toHexString(), user.subscriptionTier]));
  const hasActiveTokenByUserId = new Set(activeTokenUsers.map((tokenUser) => tokenUser._id.toHexString()));
  const recentSentAtByUserId = new Map(
    recentSentUsers.filter((row) => row.sentAt instanceof Date).map((row) => [row._id.toHexString(), row.sentAt]),
  );
  const planningConcurrency = Math.max(
    1,
    Math.min(env.LUNAR_PRODUCTIVITY_PLAN_CONCURRENCY, settingsDocs.length || 1),
  );

  let planned = 0;
  let skipped = 0;
  let alreadyPlanned = 0;
  let alreadySent = 0;
  let failed = 0;
  const skipReasons = new Map<string, number>();

  await runWithConcurrency(settingsDocs, planningConcurrency, async (settings) => {
    try {
      const userHex = settings.userId.toHexString();
      const result = await planLunarProductivityAlertForUser(
        settings,
        now,
        logger,
        collections,
        subscriptionTierByUserId.get(userHex),
        hasActiveTokenByUserId.has(userHex),
        recentSentAtByUserId.get(userHex) ?? null,
      );
      if (result.status === 'planned') {
        planned += 1;
      } else if (result.status === 'already_planned') {
        alreadyPlanned += 1;
      } else if (result.status === 'already_sent') {
        alreadySent += 1;
      } else if (result.status === 'failed') {
        failed += 1;
        logger.error({ userId: userHex, reason: result.reason, ...result.meta }, 'lunar productivity planner failed for user');
      } else {
        skipped += 1;
        const reason = result.reason || 'unknown skip reason';
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
        logger.info({ userId: userHex, reason, ...result.meta }, 'lunar productivity planner skipped for user');
      }
    } catch (error) {
      failed += 1;
      logger.error({ error, userId: settings.userId.toHexString() }, 'lunar productivity planner failed for user');
    }
  });

  logger.info(
    {
      enabledUsers: settingsDocs.length,
      planningConcurrency,
      planned,
      skipped,
      alreadyPlanned,
      alreadySent,
      failed,
      skipReasons: Object.fromEntries(skipReasons),
    },
    'lunar productivity planner cycle finished',
  );
}

async function runDispatchPass(logger: FastifyBaseLogger) {
  const now = new Date();
  const collections = await getCollections();
  const dueJobs = await collections.lunarProductivityJobs
    .find(
      {
        status: 'planned',
        scheduledAt: { $lte: now },
      },
      {
        projection: {
          _id: 1,
          userId: 1,
          dateKey: 1,
          severity: 1,
          riskScore: 1,
          impactDirection: 1,
          profileHash: 1,
          updatedAt: 1,
        },
      },
    )
    .sort({ scheduledAt: 1 })
    .limit(DISPATCH_BATCH_SIZE)
    .toArray();

  if (dueJobs.length === 0) {
    return;
  }

  const userIds = dueJobs.map((job) => job.userId);
  const [users, profiles, settingsDocs, activeTokens] = await Promise.all([
    collections.users.find({ _id: { $in: userIds } }, { projection: { _id: 1, subscriptionTier: 1 } }).toArray(),
    collections.birthProfiles
      .find({ userId: { $in: userIds } }, { projection: { userId: 1, profileHash: 1, updatedAt: 1 } })
      .toArray(),
    collections.lunarProductivitySettings
      .find({ userId: { $in: userIds } }, { projection: { userId: 1, enabled: 1 } })
      .toArray(),
    collections.pushNotificationTokens
      .aggregate<{ _id: ObjectId; userId: ObjectId; token: string }>([
        {
          $match: {
            userId: { $in: userIds },
            active: true,
          },
        },
        {
          $sort: {
            userId: 1,
            updatedAt: -1,
          },
        },
        {
          $group: {
            _id: '$userId',
            tokenDoc: { $first: '$$ROOT' },
          },
        },
        {
          $replaceRoot: {
            newRoot: '$tokenDoc',
          },
        },
        {
          $project: {
            _id: 1,
            userId: 1,
            token: 1,
          },
        },
      ])
      .toArray(),
  ]);
  const subscriptionTierByUserId = new Map(users.map((user) => [user._id.toHexString(), user.subscriptionTier]));
  const profileByUserId = new Map(profiles.map((profile) => [profile.userId.toHexString(), profile]));
  const settingsEnabledByUserId = new Map(settingsDocs.map((settings) => [settings.userId.toHexString(), settings.enabled === true]));
  const activeTokenByUserId = new Map(activeTokens.map((tokenDoc) => [tokenDoc.userId.toHexString(), tokenDoc]));
  const dispatchConcurrency = Math.max(
    1,
    Math.min(env.LUNAR_PRODUCTIVITY_DISPATCH_CONCURRENCY, dueJobs.length || 1),
  );

  let sent = 0;
  let failed = 0;
  let cancelled = 0;

  await runWithConcurrency(dueJobs, dispatchConcurrency, async (job) => {
    try {
      const userHex = job.userId.toHexString();
      const effectiveTier = resolveEffectiveSubscriptionTier(subscriptionTierByUserId.get(userHex));
      const profile = profileByUserId.get(userHex) ?? null;
      const settingsEnabled = settingsEnabledByUserId.get(userHex) === true;
      const token = activeTokenByUserId.get(userHex) ?? null;

      if (effectiveTier !== 'premium' || !settingsEnabled) {
        await collections.lunarProductivityJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'cancelled',
              lastError: !settingsEnabled ? 'lunar productivity settings disabled' : 'premium is required',
              updatedAt: now,
            },
          },
        );
        cancelled += 1;
        return;
      }

      const jobProfileHash = typeof job.profileHash === 'string' && job.profileHash.trim().length > 0 ? job.profileHash : null;
      const staleJob =
        !profile ||
        (jobProfileHash
          ? jobProfileHash !== profile.profileHash
          : job.updatedAt.getTime() < profile.updatedAt.getTime());

      if (staleJob) {
        await collections.lunarProductivityJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'cancelled',
              scheduledAt: null,
              lastError: profile ? 'birth profile changed before dispatch' : 'birth profile is required',
              updatedAt: now,
            },
          },
        );
        cancelled += 1;
        return;
      }

      if (!token) {
        await collections.lunarProductivityJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              lastError: 'active push token is missing at dispatch time',
              updatedAt: now,
            },
          },
        );
        failed += 1;
        return;
      }

      const pushResult = await sendExpoLunarProductivityPush({
        token: token.token,
        severity: job.severity,
        impactDirection: job.impactDirection ?? resolveLunarProductivityImpactDirection(job.riskScore) ?? 'disruptive',
        dateKey: job.dateKey,
        riskScore: job.riskScore,
      });

      if (!pushResult.ok) {
        await collections.lunarProductivityJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              lastError: pushResult.error,
              updatedAt: now,
            },
          },
        );
        if (pushResult.deviceNotRegistered) {
          await collections.pushNotificationTokens.updateOne(
            { _id: token._id },
            {
              $set: {
                active: false,
                updatedAt: now,
              },
            },
          );
        }
        failed += 1;
        return;
      }

      await collections.lunarProductivityJobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'sent',
            providerMessageId: pushResult.messageId,
            sentAt: now,
            lastError: null,
            updatedAt: now,
          },
        },
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      logger.error(
        {
          error,
          jobId: job._id.toHexString(),
          userId: job.userId.toHexString(),
        },
        'lunar productivity dispatch failed for job',
      );
      await collections.lunarProductivityJobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'failed',
            lastError: error instanceof Error ? error.message : 'unexpected dispatch error',
            updatedAt: now,
          },
        },
      );
    }
  });

  logger.info(
    {
      dueJobs: dueJobs.length,
      dispatchConcurrency,
      sent,
      failed,
      cancelled,
    },
    'lunar productivity dispatch cycle finished',
  );
}

export function startLunarProductivityScheduler(logger: FastifyBaseLogger) {
  if (!env.LUNAR_PRODUCTIVITY_ALERTS_ENABLED) {
    logger.info('lunar productivity scheduler is disabled by config');
    return () => undefined;
  }

  if (!shouldStartLunarProductivityScheduler({
    enabled: env.LUNAR_PRODUCTIVITY_ALERTS_ENABLED,
    expoPushAccessToken: env.EFFECTIVE_EXPO_PUSH_ACCESS_TOKEN,
  })) {
    logger.error('lunar productivity scheduler disabled because EXPO push token is missing');
    return () => undefined;
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const intervalMs = env.LUNAR_PRODUCTIVITY_CHECK_INTERVAL_SECONDS * 1000;

  const runCycle = async () => {
    const bucket = Math.floor(Date.now() / intervalMs);
    await runWithSchedulerLock({
      scheduler: 'lunar_productivity',
      scope: String(bucket),
      logger,
      meta: {
        bucket,
      },
      run: async () => {
        try {
          await runPlanningPass(logger);
          await runDispatchPass(logger);
        } catch (error) {
          logger.error({ error }, 'lunar productivity scheduler cycle failed');
        }
      },
      onLockedSkip: () => undefined,
    });
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runCycle();
      scheduleNext();
    }, intervalMs);
  };

  logger.info(
    {
      intervalSeconds: env.LUNAR_PRODUCTIVITY_CHECK_INTERVAL_SECONDS,
      lowImpactThreshold: env.LUNAR_PRODUCTIVITY_LOW_IMPACT_THRESHOLD,
      highImpactThreshold: env.LUNAR_PRODUCTIVITY_HIGH_IMPACT_THRESHOLD,
      planningConcurrency: env.LUNAR_PRODUCTIVITY_PLAN_CONCURRENCY,
      dispatchConcurrency: env.LUNAR_PRODUCTIVITY_DISPATCH_CONCURRENCY,
    },
    'lunar productivity scheduler started',
  );

  void (async () => {
    await runCycle();
    scheduleNext();
  })();

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
