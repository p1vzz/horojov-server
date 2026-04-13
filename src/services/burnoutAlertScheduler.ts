import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import {
  getCollections,
  type BurnoutAlertSeverity,
  type BurnoutAlertSettingsDoc,
  type MongoCollections,
} from '../db/mongo.js';
import { runWithConcurrency } from './asyncPool.js';
import { buildTodayDate, getOrCreateDailyTransitForUser } from './dailyTransit.js';
import {
  calculateBurnoutRisk,
  isBurnoutAlertJobCurrentForTransit,
  recordBurnoutAlertEvent,
  type BurnoutAlertEventInput,
} from './burnoutAlerts.js';
import { runWithSchedulerLock } from './schedulerLockPolicy.js';

const BURNOUT_ALERT_COOLDOWN_HOURS = 20;
const MIN_LEAD_BEFORE_PEAK_MINUTES = 10;
const MIN_SCHEDULE_AHEAD_MINUTES = 5;
const DISPATCH_BATCH_SIZE = 50;
export const BURNOUT_SAMPLE_LOCAL_HOURS = [8, 10, 12, 14, 16, 18, 20] as const;
const FORCED_SEVERITY_MIN_SCORE: Record<BurnoutAlertSeverity, number> = {
  warn: 55,
  high: 70,
  critical: 85,
};

const SEVERITY_LEAD_MINUTES: Record<BurnoutAlertSeverity, number> = {
  warn: 35,
  high: 60,
  critical: 90,
};

const BURNOUT_PUSH_COPY: Record<BurnoutAlertSeverity, { title: string; body: string }> = {
  warn: {
    title: 'Protect Your Energy Today',
    body: 'Workload pressure is rising. Keep one priority task, batch messages, and leave a real break before the next push.',
  },
  high: {
    title: 'Cut Context Switching Now',
    body: 'Burnout pressure is high. Finish the main task first, move low-value meetings, and avoid taking on new work today.',
  },
  critical: {
    title: 'Reduce Load Before It Spikes',
    body: 'Your recovery buffer is thin. Pause new commitments, close one critical item, and schedule recovery time before more deep work.',
  },
};

type LocalDateTimeParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

type ScheduleResult =
  | {
      status: 'planned';
      scheduledAt: Date;
      predictedPeakAt: Date;
      dateKey: string;
    }
  | {
      status: 'skip';
      reason: string;
      predictedPeakAt: Date;
      dateKey: string;
    };

type PlanResult =
  | { status: 'planned'; meta?: Record<string, unknown> }
  | { status: 'skipped'; reason: string; meta?: Record<string, unknown> }
  | { status: 'already_planned'; meta?: Record<string, unknown> }
  | { status: 'already_sent'; meta?: Record<string, unknown> }
  | { status: 'failed'; reason: string; meta?: Record<string, unknown> };

export type BurnoutHourlyStressScore = {
  hour: number;
  score: number;
};

type BurnoutPeakPrediction = {
  hour: number;
  predictedPeakMinute: number;
  hourlyScores: BurnoutHourlyStressScore[];
};

type BurnoutRiskForTiming = ReturnType<typeof calculateBurnoutRisk>;

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
  deltaDays: number
): Pick<LocalDateTimeParts, 'year' | 'month' | 'day'> {
  const shifted = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + deltaDays));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

function applyMinuteWithOverflow(
  parts: LocalDateTimeParts,
  minuteValue: number
): LocalDateTimeParts {
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
  quietEndMinute: number
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

function resolveWorkdayMidHour(settings: Pick<BurnoutAlertSettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>) {
  return (settings.workdayStartMinute + settings.workdayEndMinute) / 120;
}

function resolveSaturnTimingHousePressure(house: number | null) {
  if (house === 12) return 14;
  if (house === 10) return 12;
  if (house === 6) return 10;
  if (house === 8) return 8;
  if (house === 1) return 6;
  return 4;
}

function resolveMoonTimingHousePressure(house: number | null) {
  if (house === 12) return 12;
  if (house === 8) return 10;
  if (house === 6) return 9;
  if (house === 10) return 8;
  if (house === 3) return 7;
  return 4;
}

const SATURN_HOUSE_PEAK_HOURS: Record<number, number> = {
  1: 9,
  6: 11,
  8: 14,
  10: 15,
  12: 16,
};

const MOON_HOUSE_PEAK_HOURS: Record<number, number> = {
  3: 11,
  6: 10,
  8: 15,
  10: 16,
  12: 17,
};

function resolveHousePeakHour(
  house: number | null,
  peakHours: Record<number, number>,
  fallbackHour: number,
) {
  if (house === null) return fallbackHour;
  return peakHours[house] ?? fallbackHour;
}

function resolveBurnoutTargetStressHour(input: {
  settings: Pick<BurnoutAlertSettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>;
  risk: BurnoutRiskForTiming;
}) {
  const workdayMidHour = resolveWorkdayMidHour(input.settings);
  const saturnPressure = resolveSaturnTimingHousePressure(input.risk.signals.saturn.house);
  const moonPressure = resolveMoonTimingHousePressure(input.risk.signals.moon.house);
  const pressureTotal = Math.max(1, saturnPressure + moonPressure);
  const saturnWeight = saturnPressure / pressureTotal;
  const moonWeight = moonPressure / pressureTotal;
  const saturnHour = resolveHousePeakHour(
    input.risk.signals.saturn.house,
    SATURN_HOUSE_PEAK_HOURS,
    workdayMidHour,
  );
  const moonHour = resolveHousePeakHour(input.risk.signals.moon.house, MOON_HOUSE_PEAK_HOURS, workdayMidHour);
  const focusMomentum = input.risk.signals.momentum.focus;
  const energyFocusSpread = input.risk.signals.momentum.energy - focusMomentum;
  const momentumShift =
    focusMomentum <= -5 || energyFocusSpread >= 8
      ? -1
      : focusMomentum >= 4 && energyFocusSpread <= 3
        ? 1
        : 0;
  const targetHour =
    saturnHour * (0.34 + saturnWeight * 0.2) +
    moonHour * (0.3 + moonWeight * 0.18) +
    workdayMidHour * 0.16 +
    momentumShift;

  return clamp(Math.round(targetHour), 8, 20);
}

export function estimateBurnoutHourlyStressScores(input: {
  riskScore: number;
  settings: Pick<BurnoutAlertSettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>;
  risk: BurnoutRiskForTiming;
}) {
  const targetHour = resolveBurnoutTargetStressHour(input);
  const saturnPeakHour = resolveHousePeakHour(
    input.risk.signals.saturn.house,
    SATURN_HOUSE_PEAK_HOURS,
    targetHour,
  );
  const moonPeakHour = resolveHousePeakHour(input.risk.signals.moon.house, MOON_HOUSE_PEAK_HOURS, targetHour);
  const saturnHousePressure = resolveSaturnTimingHousePressure(input.risk.signals.saturn.house);
  const moonHousePressure = resolveMoonTimingHousePressure(input.risk.signals.moon.house);

  return BURNOUT_SAMPLE_LOCAL_HOURS.map((hour) => {
    const targetAlignment = clamp(1 - Math.abs(hour - targetHour) / 8, 0.2, 1);
    const saturnAlignment = clamp(1 - Math.abs(hour - saturnPeakHour) / 8, 0.2, 1);
    const moonAlignment = clamp(1 - Math.abs(hour - moonPeakHour) / 7, 0.2, 1);
    const positiveAlignment = clamp(1 - Math.abs(hour - (targetHour - 2)) / 9, 0.2, 1);
    const hourHardStrength =
      (input.risk.signals.saturnHardCount +
        input.risk.signals.moonHardCount +
        input.risk.signals.saturnMoonHard) *
      targetAlignment;
    const hourSaturnHard = input.risk.signals.saturnHardCount * saturnAlignment;
    const hourMoonHard = input.risk.signals.moonHardCount * moonAlignment;
    const hourSaturnMoonHard = input.risk.signals.saturnMoonHard * targetAlignment;
    const hourPositiveStrength = input.risk.signals.positiveAspectStrength * positiveAlignment;
    const score = clamp(
      input.riskScore * 0.52 +
        hourHardStrength * 6 +
        hourSaturnHard * 8 +
        hourMoonHard * 7 +
        hourSaturnMoonHard * 10 +
        saturnHousePressure * 0.9 * saturnAlignment +
        moonHousePressure * 0.8 * moonAlignment -
        hourPositiveStrength * 4,
      0,
      100,
    );

    return {
      hour,
      score: Number(score.toFixed(2)),
    } satisfies BurnoutHourlyStressScore;
  });
}

export function resolveBurnoutPredictedPeakLocalMinute(input: {
  riskScore: number;
  settings: Pick<BurnoutAlertSettingsDoc, 'workdayStartMinute' | 'workdayEndMinute'>;
  risk: BurnoutRiskForTiming;
}): BurnoutPeakPrediction {
  const hourlyScores = estimateBurnoutHourlyStressScores(input);
  let best = hourlyScores[0];

  for (const candidate of hourlyScores.slice(1)) {
    if (candidate.score > (best?.score ?? Number.NEGATIVE_INFINITY)) {
      best = candidate;
      continue;
    }
    if (candidate.score === best?.score && candidate.hour < best.hour) {
      best = candidate;
    }
  }

  const hour = best?.hour ?? BURNOUT_SAMPLE_LOCAL_HOURS[0];
  return {
    hour,
    predictedPeakMinute: hour * 60 + 30,
    hourlyScores,
  };
}

export function computeBurnoutScheduleFromPredictedPeakMinute(input: {
  now: Date;
  settings: BurnoutAlertSettingsDoc;
  severity: BurnoutAlertSeverity;
  predictedPeakMinute: number;
}): ScheduleResult {
  const { now, settings, severity, predictedPeakMinute } = input;
  const leadMinutes = SEVERITY_LEAD_MINUTES[severity];
  const todayLocal = toLocalDateTimeParts(now, settings.timezoneIana);
  const todayDateKey = localDateKey(todayLocal);
  const predictedPeakLocal = applyMinuteWithOverflow(todayLocal, predictedPeakMinute);
  const predictedPeakAt = localDateTimeToUtc(predictedPeakLocal, settings.timezoneIana);

  let candidateLocal = applyMinuteWithOverflow(todayLocal, predictedPeakMinute - leadMinutes);
  candidateLocal = moveOutOfQuietWindow(
    candidateLocal,
    settings.quietHoursStartMinute,
    settings.quietHoursEndMinute
  );

  if (localDateKey(candidateLocal) !== todayDateKey) {
    return {
      status: 'skip',
      reason: 'candidate moved outside local day',
      predictedPeakAt,
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
      predictedPeakAt,
      dateKey: todayDateKey,
    };
  }

  let scheduledAt = localDateTimeToUtc(candidateLocal, settings.timezoneIana);
  const minScheduleAt = new Date(now.getTime() + MIN_SCHEDULE_AHEAD_MINUTES * 60_000);
  if (scheduledAt.getTime() < minScheduleAt.getTime()) {
    const latestAllowedAt = predictedPeakAt.getTime() - MIN_LEAD_BEFORE_PEAK_MINUTES * 60_000;
    if (minScheduleAt.getTime() > latestAllowedAt) {
      return {
        status: 'skip',
        reason: 'minimum schedule window is later than allowed lead',
        predictedPeakAt,
        dateKey: todayDateKey,
      };
    }
    scheduledAt = minScheduleAt;
  }

  const latestAllowedAt = predictedPeakAt.getTime() - MIN_LEAD_BEFORE_PEAK_MINUTES * 60_000;
  if (scheduledAt.getTime() > latestAllowedAt) {
    return {
      status: 'skip',
      reason: 'candidate violates peak lead constraint',
      predictedPeakAt,
      dateKey: todayDateKey,
    };
  }

  return {
    status: 'planned',
    scheduledAt,
    predictedPeakAt,
    dateKey: todayDateKey,
  };
}

export function shouldStartBurnoutAlertScheduler(input: {
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

async function sendExpoBurnoutPush(input: {
  token: string;
  severity: BurnoutAlertSeverity;
  dateKey: string;
  riskScore: number;
}) {
  const copy = BURNOUT_PUSH_COPY[input.severity];
  const payload = [
    {
      to: input.token,
      title: copy.title,
      body: copy.body,
      sound: 'default',
      channelId: 'default',
      priority: 'high',
      data: {
        type: 'burnout_alert',
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
  const firstResult = Array.isArray(dataNode)
    ? dataNode[0]
    : dataNode;

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

async function markUserPlannedJobCancelled(
  userId: ObjectId,
  now: Date,
  reason: string,
  collections: MongoCollections
) {
  await collections.burnoutAlertJobs.updateMany(
    {
      userId,
      status: 'planned',
    },
    {
      $set: {
        status: 'cancelled',
        lastError: reason,
        updatedAt: now,
      },
    }
  );
}

async function markCurrentDayPlanCancelled(input: {
  collections: MongoCollections;
  logger: FastifyBaseLogger;
  userId: ObjectId;
  dateKey: string;
  now: Date;
  reason: string;
}) {
  const result = await input.collections.burnoutAlertJobs.updateOne(
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
    }
  );
  if (result.modifiedCount > 0) {
    await recordBurnoutSchedulerEvent(input.collections, input.logger, {
      userId: input.userId,
      dateKey: input.dateKey,
      type: 'cancelled',
      reason: input.reason,
      now: input.now,
    });
  }
}

function toIsoOrNull(value: Date | null | undefined) {
  return value ? value.toISOString() : null;
}

async function recordBurnoutSchedulerEvent(
  collections: MongoCollections,
  logger: FastifyBaseLogger,
  input: BurnoutAlertEventInput
) {
  try {
    await recordBurnoutAlertEvent({
      collections,
      ...input,
    });
  } catch (error) {
    logger.warn(
      {
        error,
        eventType: input.type,
        userId: input.userId.toHexString(),
        dateKey: input.dateKey ?? null,
      },
      'burnout alert event recording failed'
    );
  }
}

function resolveEffectiveSubscriptionTier(input: 'free' | 'premium' | undefined) {
  if (env.DEV_FORCE_PREMIUM_FOR_ALL_USERS) return 'premium' as const;
  return input === 'premium' ? 'premium' : 'free';
}

async function planBurnoutAlertForUser(
  settings: BurnoutAlertSettingsDoc,
  now: Date,
  logger: FastifyBaseLogger,
  collections: MongoCollections,
  subscriptionTier: 'free' | 'premium' | undefined,
  hasActivePushToken: boolean,
  recentSentAt: Date | null
): Promise<PlanResult> {
  const effectiveTier = resolveEffectiveSubscriptionTier(subscriptionTier);
  if (effectiveTier !== 'premium') {
    await markUserPlannedJobCancelled(settings.userId, now, 'premium is required', collections);
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
      await markUserPlannedJobCancelled(
        settings.userId,
        now,
        'birth profile is required',
        collections
      );
      return {
        status: 'skipped',
        reason: 'birth profile is required',
      };
    }
    throw error;
  }

  const risk = calculateBurnoutRisk(transit.doc);
  const effectiveSeverity = env.BURNOUT_ALERT_FORCE_SEVERITY ?? risk.severity;
  const effectiveRiskScore = env.BURNOUT_ALERT_FORCE_SEVERITY
    ? Math.max(risk.riskScore, FORCED_SEVERITY_MIN_SCORE[env.BURNOUT_ALERT_FORCE_SEVERITY])
    : risk.riskScore;

  if (effectiveSeverity === 'none' || effectiveRiskScore < env.BURNOUT_ALERT_MIN_SCORE) {
    await markCurrentDayPlanCancelled({
      collections,
      logger,
      userId: settings.userId,
      dateKey: transit.doc.dateKey,
      now,
      reason: 'risk below threshold',
    });
    return {
      status: 'skipped',
      reason: 'risk below threshold',
      meta: {
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        minScore: env.BURNOUT_ALERT_MIN_SCORE,
      },
    };
  }

  const peakPrediction = resolveBurnoutPredictedPeakLocalMinute({
    riskScore: effectiveRiskScore,
    settings,
    risk,
  });
  const schedule = computeBurnoutScheduleFromPredictedPeakMinute({
    now,
    settings,
    severity: effectiveSeverity,
    predictedPeakMinute: peakPrediction.predictedPeakMinute,
  });
  const dateKey = schedule.dateKey;

  const latestJob = await collections.burnoutAlertJobs.findOne(
    {
      userId: settings.userId,
      dateKey,
    },
    {
      projection: {
        status: 1,
        sentAt: 1,
        scheduledAt: 1,
        severity: 1,
        riskScore: 1,
        seenAt: 1,
        profileHash: 1,
        lastError: 1,
        updatedAt: 1,
      },
    }
  );
  const existingJob = isBurnoutAlertJobCurrentForTransit(latestJob, transit.doc) ? latestJob : null;

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
      },
    };
  }

  if (recentSentAt) {
    const reason = 'cooldown active';
    const shouldRecordEvent =
      latestJob?.status !== 'skipped' ||
      latestJob.lastError !== reason ||
      !isBurnoutAlertJobCurrentForTransit(latestJob, transit.doc);
    await collections.burnoutAlertJobs.updateOne(
      { userId: settings.userId, dateKey },
      {
        $set: {
          profileHash: transit.doc.profileHash,
          severity: effectiveSeverity,
          riskScore: effectiveRiskScore,
          predictedPeakAt: schedule.predictedPeakAt,
          scheduledAt: null,
          status: 'skipped',
          providerMessageId: null,
          sentAt: null,
          lastError: reason,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          createdAt: now,
        },
      },
      { upsert: true }
    );
    if (shouldRecordEvent) {
      await recordBurnoutSchedulerEvent(collections, logger, {
        userId: settings.userId,
        jobId: latestJob?._id ?? null,
        profileHash: transit.doc.profileHash,
        dateKey,
        type: 'skipped',
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        reason,
        metadata: {
          recentSentAt: toIsoOrNull(recentSentAt),
        },
        now,
      });
    }
    return {
      status: 'skipped',
      reason,
      meta: {
        dateKey,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        recentSentAt: toIsoOrNull(recentSentAt),
      },
    };
  }

  if (!hasActivePushToken) {
    const reason = 'active push token is missing';
    const shouldRecordEvent =
      latestJob?.status !== 'skipped' ||
      latestJob.lastError !== reason ||
      !isBurnoutAlertJobCurrentForTransit(latestJob, transit.doc);
    await collections.burnoutAlertJobs.updateOne(
      { userId: settings.userId, dateKey },
      {
        $set: {
          profileHash: transit.doc.profileHash,
          severity: effectiveSeverity,
          riskScore: effectiveRiskScore,
          predictedPeakAt: schedule.predictedPeakAt,
          scheduledAt: null,
          status: 'skipped',
          providerMessageId: null,
          sentAt: null,
          lastError: reason,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          createdAt: now,
        },
      },
      { upsert: true }
    );
    if (shouldRecordEvent) {
      await recordBurnoutSchedulerEvent(collections, logger, {
        userId: settings.userId,
        jobId: latestJob?._id ?? null,
        profileHash: transit.doc.profileHash,
        dateKey,
        type: 'skipped',
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        reason,
        now,
      });
    }
    return {
      status: 'skipped',
      reason,
      meta: {
        dateKey,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
      },
    };
  }

  if (schedule.status === 'skip') {
    const reason = schedule.reason;
    const shouldRecordEvent =
      latestJob?.status !== 'skipped' ||
      latestJob.lastError !== reason ||
      !isBurnoutAlertJobCurrentForTransit(latestJob, transit.doc);
    await collections.burnoutAlertJobs.updateOne(
      { userId: settings.userId, dateKey },
      {
        $set: {
          profileHash: transit.doc.profileHash,
          severity: effectiveSeverity,
          riskScore: effectiveRiskScore,
          predictedPeakAt: schedule.predictedPeakAt,
          scheduledAt: null,
          status: 'skipped',
          providerMessageId: null,
          sentAt: null,
          lastError: reason,
          updatedAt: now,
        },
        $setOnInsert: {
          _id: new ObjectId(),
          createdAt: now,
        },
      },
      { upsert: true }
    );
    if (shouldRecordEvent) {
      await recordBurnoutSchedulerEvent(collections, logger, {
        userId: settings.userId,
        jobId: latestJob?._id ?? null,
        profileHash: transit.doc.profileHash,
        dateKey,
        type: 'skipped',
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        reason,
        metadata: {
          predictedPeakAt: schedule.predictedPeakAt.toISOString(),
          peakHour: peakPrediction.hour,
          hourlyStressPeakScore: peakPrediction.hourlyScores.find((entry) => entry.hour === peakPrediction.hour)?.score ?? null,
        },
        now,
      });
    }
    return {
      status: 'skipped',
      reason,
      meta: {
        dateKey,
        timezoneIana: settings.timezoneIana,
        workdayStartMinute: settings.workdayStartMinute,
        workdayEndMinute: settings.workdayEndMinute,
        quietHoursStartMinute: settings.quietHoursStartMinute,
        quietHoursEndMinute: settings.quietHoursEndMinute,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        predictedPeakAt: schedule.predictedPeakAt.toISOString(),
        peakHour: peakPrediction.hour,
        hourlyStressPeakScore: peakPrediction.hourlyScores.find((entry) => entry.hour === peakPrediction.hour)?.score ?? null,
      },
    };
  }

  await collections.burnoutAlertJobs.updateOne(
    { userId: settings.userId, dateKey },
    {
      $set: {
        profileHash: transit.doc.profileHash,
        severity: effectiveSeverity,
        riskScore: effectiveRiskScore,
        predictedPeakAt: schedule.predictedPeakAt,
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
    { upsert: true }
  );
  await recordBurnoutSchedulerEvent(collections, logger, {
    userId: settings.userId,
    jobId: latestJob?._id ?? null,
    profileHash: transit.doc.profileHash,
    dateKey,
    type: 'planned',
    severity: effectiveSeverity,
    riskScore: effectiveRiskScore,
    metadata: {
      scheduledAt: schedule.scheduledAt.toISOString(),
      predictedPeakAt: schedule.predictedPeakAt.toISOString(),
      peakHour: peakPrediction.hour,
      hourlyStressPeakScore: peakPrediction.hourlyScores.find((entry) => entry.hour === peakPrediction.hour)?.score ?? null,
    },
    now,
  });

  return {
    status: 'planned',
    meta: {
      dateKey,
      severity: effectiveSeverity,
      riskScore: effectiveRiskScore,
      scheduledAt: schedule.scheduledAt.toISOString(),
      predictedPeakAt: schedule.predictedPeakAt.toISOString(),
      peakHour: peakPrediction.hour,
      hourlyStressPeakScore: peakPrediction.hourlyScores.find((entry) => entry.hour === peakPrediction.hour)?.score ?? null,
    },
  };
}

async function runPlanningPass(logger: FastifyBaseLogger) {
  const now = new Date();
  const collections = await getCollections();
  const settingsDocs = await collections.burnoutAlertSettings
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
      }
    )
    .toArray();
  const userIdMap = new Map(
    settingsDocs.map((settings) => [settings.userId.toHexString(), settings.userId])
  );
  const userIds = Array.from(userIdMap.values());
  const cooldownBoundary = new Date(now.getTime() - BURNOUT_ALERT_COOLDOWN_HOURS * 60 * 60 * 1000);
  const [users, activeTokenUsers, recentSentUsers] = userIds.length
    ? await Promise.all([
        collections.users
          .find(
            { _id: { $in: userIds } },
            { projection: { _id: 1, subscriptionTier: 1 } }
          )
          .toArray(),
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
        collections.burnoutAlertJobs
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
  const subscriptionTierByUserId = new Map(
    users.map((user) => [user._id.toHexString(), user.subscriptionTier])
  );
  const hasActiveTokenByUserId = new Set(
    activeTokenUsers.map((tokenUser) => tokenUser._id.toHexString())
  );
  const recentSentAtByUserId = new Map(
    recentSentUsers
      .filter((row) => row.sentAt instanceof Date)
      .map((row) => [row._id.toHexString(), row.sentAt])
  );
  const planningConcurrency = Math.max(
    1,
    Math.min(env.BURNOUT_ALERT_PLAN_CONCURRENCY, settingsDocs.length || 1)
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
      const result = await planBurnoutAlertForUser(
        settings,
        now,
        logger,
        collections,
        subscriptionTierByUserId.get(userHex),
        hasActiveTokenByUserId.has(userHex),
        recentSentAtByUserId.get(userHex) ?? null
      );
      if (result.status === 'planned') {
        planned += 1;
      } else if (result.status === 'already_planned') {
        alreadyPlanned += 1;
      } else if (result.status === 'already_sent') {
        alreadySent += 1;
      } else if (result.status === 'failed') {
        failed += 1;
        logger.error(
          {
            userId: userHex,
            reason: result.reason,
            ...result.meta,
          },
          'burnout planner failed for user'
        );
      } else {
        skipped += 1;
        const reason = result.reason || 'unknown skip reason';
        skipReasons.set(reason, (skipReasons.get(reason) ?? 0) + 1);
        logger.info(
          {
            userId: userHex,
            reason,
            ...result.meta,
          },
          'burnout planner skipped for user'
        );
      }
    } catch (error) {
      failed += 1;
      logger.error(
        {
          error,
          userId: settings.userId.toHexString(),
        },
        'burnout planner failed for user'
      );
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
    'burnout planner cycle finished'
  );
}

async function runDispatchPass(logger: FastifyBaseLogger) {
  const now = new Date();
  const collections = await getCollections();
  const dueJobs = await collections.burnoutAlertJobs
    .find({
      status: 'planned',
      scheduledAt: { $lte: now },
    }, {
      projection: {
        _id: 1,
        userId: 1,
        dateKey: 1,
        severity: 1,
        riskScore: 1,
        profileHash: 1,
        updatedAt: 1,
      },
    })
    .sort({
      scheduledAt: 1,
    })
    .limit(DISPATCH_BATCH_SIZE)
    .toArray();
  if (dueJobs.length === 0) {
    return;
  }
  const userIdMap = new Map(dueJobs.map((job) => [job.userId.toHexString(), job.userId]));
  const userIds = Array.from(userIdMap.values());
  const [users, profiles, settingsDocs, activeTokens] = await Promise.all([
    collections.users
      .find(
        { _id: { $in: userIds } },
        { projection: { _id: 1, subscriptionTier: 1 } }
      )
      .toArray(),
    collections.birthProfiles
      .find(
        { userId: { $in: userIds } },
        { projection: { userId: 1, profileHash: 1, updatedAt: 1 } }
      )
      .toArray(),
    collections.burnoutAlertSettings
      .find(
        { userId: { $in: userIds } },
        { projection: { userId: 1, enabled: 1 } }
      )
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
  const subscriptionTierByUserId = new Map(
    users.map((user) => [user._id.toHexString(), user.subscriptionTier])
  );
  const profileByUserId = new Map(
    profiles.map((profile) => [profile.userId.toHexString(), profile])
  );
  const settingsEnabledByUserId = new Map(
    settingsDocs.map((settings) => [settings.userId.toHexString(), settings.enabled === true])
  );
  const activeTokenByUserId = new Map(
    activeTokens.map((tokenDoc) => [tokenDoc.userId.toHexString(), tokenDoc])
  );
  const dispatchConcurrency = Math.max(
    1,
    Math.min(env.BURNOUT_ALERT_DISPATCH_CONCURRENCY, dueJobs.length || 1)
  );

  let sent = 0;
  let failed = 0;
  let cancelled = 0;

  await runWithConcurrency(dueJobs, dispatchConcurrency, async (job) => {
    try {
      const userHex = job.userId.toHexString();
      const effectiveTier = resolveEffectiveSubscriptionTier(
        subscriptionTierByUserId.get(userHex)
      );
      const profile = profileByUserId.get(userHex) ?? null;
      const settingsEnabled = settingsEnabledByUserId.get(userHex) === true;
      const token = activeTokenByUserId.get(userHex) ?? null;

      if (effectiveTier !== 'premium' || !settingsEnabled) {
        const reason = !settingsEnabled ? 'burnout settings disabled' : 'premium is required';
        await collections.burnoutAlertJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'cancelled',
              lastError: reason,
              updatedAt: now,
            },
          }
        );
        await recordBurnoutSchedulerEvent(collections, logger, {
          userId: job.userId,
          jobId: job._id,
          profileHash: typeof job.profileHash === 'string' ? job.profileHash : null,
          dateKey: job.dateKey,
          type: 'cancelled',
          severity: job.severity,
          riskScore: job.riskScore,
          reason,
          now,
        });
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
        const reason = profile ? 'birth profile changed before dispatch' : 'birth profile is required';
        await collections.burnoutAlertJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'cancelled',
              scheduledAt: null,
              lastError: reason,
              updatedAt: now,
            },
          }
        );
        await recordBurnoutSchedulerEvent(collections, logger, {
          userId: job.userId,
          jobId: job._id,
          profileHash: typeof job.profileHash === 'string' ? job.profileHash : null,
          dateKey: job.dateKey,
          type: 'cancelled',
          severity: job.severity,
          riskScore: job.riskScore,
          reason,
          now,
        });
        cancelled += 1;
        return;
      }

      if (!token) {
        const reason = 'active push token is missing at dispatch time';
        await collections.burnoutAlertJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              lastError: reason,
              updatedAt: now,
            },
          }
        );
        await recordBurnoutSchedulerEvent(collections, logger, {
          userId: job.userId,
          jobId: job._id,
          profileHash: typeof job.profileHash === 'string' ? job.profileHash : null,
          dateKey: job.dateKey,
          type: 'failed',
          severity: job.severity,
          riskScore: job.riskScore,
          reason,
          now,
        });
        failed += 1;
        return;
      }

      const pushResult = await sendExpoBurnoutPush({
        token: token.token,
        severity: job.severity,
        dateKey: job.dateKey,
        riskScore: job.riskScore,
      });

      if (!pushResult.ok) {
        await collections.burnoutAlertJobs.updateOne(
          { _id: job._id },
          {
            $set: {
              status: 'failed',
              lastError: pushResult.error,
              updatedAt: now,
            },
          }
        );
        await recordBurnoutSchedulerEvent(collections, logger, {
          userId: job.userId,
          jobId: job._id,
          profileHash: typeof job.profileHash === 'string' ? job.profileHash : null,
          dateKey: job.dateKey,
          type: 'failed',
          severity: job.severity,
          riskScore: job.riskScore,
          reason: pushResult.error,
          metadata: {
            deviceNotRegistered: pushResult.deviceNotRegistered,
          },
          now,
        });
        if (pushResult.deviceNotRegistered) {
          await collections.pushNotificationTokens.updateOne(
            { _id: token._id },
            {
              $set: {
                active: false,
                updatedAt: now,
              },
            }
          );
        }
        failed += 1;
        return;
      }

      await collections.burnoutAlertJobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'sent',
            providerMessageId: pushResult.messageId,
            sentAt: now,
            lastError: null,
            updatedAt: now,
          },
        }
      );
      await recordBurnoutSchedulerEvent(collections, logger, {
        userId: job.userId,
        jobId: job._id,
        profileHash: typeof job.profileHash === 'string' ? job.profileHash : null,
        dateKey: job.dateKey,
        type: 'sent',
        severity: job.severity,
        riskScore: job.riskScore,
        providerMessageId: pushResult.messageId,
        now,
      });
      sent += 1;
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'unexpected dispatch error';
      failed += 1;
      logger.error(
        {
          error,
          jobId: job._id.toHexString(),
          userId: job.userId.toHexString(),
        },
        'burnout dispatch failed for job'
      );
      await collections.burnoutAlertJobs.updateOne(
        { _id: job._id },
        {
          $set: {
            status: 'failed',
            lastError: reason,
            updatedAt: now,
          },
        }
      );
      await recordBurnoutSchedulerEvent(collections, logger, {
        userId: job.userId,
        jobId: job._id,
        profileHash: typeof job.profileHash === 'string' ? job.profileHash : null,
        dateKey: job.dateKey,
        type: 'failed',
        severity: job.severity,
        riskScore: job.riskScore,
        reason,
        now,
      });
    }
  });

  if (dueJobs.length > 0) {
    logger.info(
      {
        dueJobs: dueJobs.length,
        dispatchConcurrency,
        sent,
        failed,
        cancelled,
      },
      'burnout dispatch cycle finished'
    );
  }
}

export function startBurnoutAlertScheduler(logger: FastifyBaseLogger) {
  if (!env.BURNOUT_ALERTS_ENABLED) {
    logger.info('burnout alert scheduler is disabled by config');
    return () => undefined;
  }

  if (!shouldStartBurnoutAlertScheduler({
    enabled: env.BURNOUT_ALERTS_ENABLED,
    expoPushAccessToken: env.EFFECTIVE_EXPO_PUSH_ACCESS_TOKEN,
  })) {
    logger.error('burnout alert scheduler disabled because EXPO push token is missing');
    return () => undefined;
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const intervalMs = env.BURNOUT_ALERT_CHECK_INTERVAL_SECONDS * 1000;

  const runCycle = async () => {
    const bucket = Math.floor(Date.now() / intervalMs);
    await runWithSchedulerLock({
      scheduler: 'burnout_alerts',
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
          logger.error({ error }, 'burnout scheduler cycle failed');
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
      intervalSeconds: env.BURNOUT_ALERT_CHECK_INTERVAL_SECONDS,
      minScore: env.BURNOUT_ALERT_MIN_SCORE,
      sampleLocalHours: BURNOUT_SAMPLE_LOCAL_HOURS,
      planningConcurrency: env.BURNOUT_ALERT_PLAN_CONCURRENCY,
      dispatchConcurrency: env.BURNOUT_ALERT_DISPATCH_CONCURRENCY,
    },
    'burnout alert scheduler started'
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
