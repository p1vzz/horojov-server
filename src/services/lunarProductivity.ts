import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  getCollections,
  type BurnoutAlertSeverity,
  type DailyTransitDoc,
  type LunarProductivityImpactDirection,
  type LunarProductivityJobDoc,
  type LunarProductivityRiskSeverity,
  type LunarProductivitySettingsDoc,
} from '../db/mongo.js';

export const LUNAR_PRODUCTIVITY_RISK_ALGORITHM_VERSION = 'lunar-productivity-risk-v1';
export const LUNAR_PRODUCTIVITY_TIMING_ALGORITHM_VERSION = 'lunar-productivity-timing-v1';

export type LunarPhase =
  | 'new_moon'
  | 'waxing_crescent'
  | 'first_quarter'
  | 'waxing_gibbous'
  | 'full_moon'
  | 'waning_gibbous'
  | 'last_quarter'
  | 'waning_crescent';

export type LunarProductivitySettingsView = {
  enabled: boolean;
  timezoneIana: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  updatedAt: string | null;
  source: 'default' | 'saved';
};

export type LunarProductivityTimingSignals = {
  moonPhase: LunarPhase;
  illuminationPercent: number;
  moonHouse: number | null;
  moonHardCount: number;
  moonSaturnHard: number;
  moonMercuryHard: number;
  supportiveAspectStrength: number;
  momentum: {
    energy: number;
    focus: number;
  };
};

const chartSnapshotSchema = z
  .object({
    houses: z
      .array(
        z.object({
          house_id: z.number(),
          planets: z
            .array(
              z.object({
                name: z.string(),
              }),
            )
            .optional(),
        }),
      )
      .default([]),
    aspects: z
      .array(
        z.object({
          aspecting_planet: z.string(),
          aspected_planet: z.string(),
          type: z.string(),
          orb: z.number().optional(),
          diff: z.number().optional(),
        }),
      )
      .default([]),
  })
  .passthrough();

const DEFAULT_SETTINGS: Omit<LunarProductivitySettingsView, 'updatedAt' | 'source'> = {
  enabled: false,
  timezoneIana: 'America/New_York',
  workdayStartMinute: 540,
  workdayEndMinute: 1230,
  quietHoursStartMinute: 1290,
  quietHoursEndMinute: 480,
};

const PHASE_SEQUENCE: LunarPhase[] = [
  'new_moon',
  'waxing_crescent',
  'first_quarter',
  'waxing_gibbous',
  'full_moon',
  'waning_gibbous',
  'last_quarter',
  'waning_crescent',
];

const PHASE_LOAD_BASE: Record<LunarPhase, number> = {
  new_moon: 14,
  waxing_crescent: 10,
  first_quarter: 12,
  waxing_gibbous: 9,
  full_moon: 16,
  waning_gibbous: 8,
  last_quarter: 11,
  waning_crescent: 7,
};

const KNOWN_NEW_MOON_UTC_MS = Date.UTC(2000, 0, 6, 18, 14, 0, 0);
const SYNODIC_MONTH_DAYS = 29.530588853;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizePlanetName(value: string) {
  return value.trim().toLowerCase();
}

function isHardAspectType(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.includes('square') || normalized.includes('opposition') || normalized.includes('quincunx');
}

function maxOrbForAspect(value: string) {
  const normalized = value.trim().toLowerCase();
  if (normalized.includes('quincunx')) return 6;
  return 8;
}

function resolveAspectOrb(input: { orb?: number; diff?: number }) {
  if (typeof input.orb === 'number' && Number.isFinite(input.orb)) return Math.abs(input.orb);
  if (typeof input.diff === 'number' && Number.isFinite(input.diff)) return Math.abs(input.diff);
  return null;
}

function orbWeight(aspectType: string, orb: number | null) {
  const maxOrb = maxOrbForAspect(aspectType);
  if (orb === null) return 0.2;
  return clamp(1 - Math.min(orb, maxOrb) / maxOrb, 0.2, 1);
}

function scoreForTag(tags: DailyTransitDoc['vibe']['tags'] | undefined, label: string) {
  const found = (tags ?? []).find((entry) => entry.label === label);
  return typeof found?.score === 'number' ? clamp(found.score, 0, 100) : 0;
}

function parseChartSnapshot(input: unknown) {
  const parsed = chartSnapshotSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

function resolveMoonHouse(chart: ReturnType<typeof parseChartSnapshot>, transit: Pick<DailyTransitDoc, 'vibe'>) {
  if (chart) {
    for (const house of chart.houses) {
      for (const body of house.planets ?? []) {
        if (normalizePlanetName(body.name) === 'moon') {
          return Number.isFinite(house.house_id) ? house.house_id : null;
        }
      }
    }
  }

  const dominantPlanet = normalizePlanetName(transit.vibe.dominant.planet);
  if (dominantPlanet === 'moon' && Number.isFinite(transit.vibe.dominant.house)) {
    return transit.vibe.dominant.house;
  }

  return null;
}

function resolveMoonHardSignals(chart: ReturnType<typeof parseChartSnapshot>) {
  if (!chart) {
    return {
      moonHardCount: 0,
      moonSaturnHard: 0,
      moonMercuryHard: 0,
    };
  }

  let moonHardCount = 0;
  let moonSaturnHard = 0;
  let moonMercuryHard = 0;

  for (const aspect of chart.aspects) {
    if (!isHardAspectType(aspect.type)) continue;

    const left = normalizePlanetName(aspect.aspecting_planet);
    const right = normalizePlanetName(aspect.aspected_planet);
    const weight = orbWeight(aspect.type, resolveAspectOrb(aspect));

    const hasMoon = left === 'moon' || right === 'moon';
    if (!hasMoon) continue;

    moonHardCount += weight;

    const hasSaturn = left === 'saturn' || right === 'saturn';
    if (hasSaturn) {
      moonSaturnHard = Math.max(moonSaturnHard, weight);
    }

    const hasMercury = left === 'mercury' || right === 'mercury';
    if (hasMercury) {
      moonMercuryHard = Math.max(moonMercuryHard, weight);
    }
  }

  return {
    moonHardCount: Number(moonHardCount.toFixed(2)),
    moonSaturnHard: Number(moonSaturnHard.toFixed(2)),
    moonMercuryHard: Number(moonMercuryHard.toFixed(2)),
  };
}

function parseDateKeyAsUtcMidday(dateKey: string) {
  const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!parsed) return new Date();
  const year = Number(parsed[1]);
  const month = Number(parsed[2]);
  const day = Number(parsed[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return new Date();
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

function resolveMoonPhaseAndIllumination(dateKey: string) {
  const targetDate = parseDateKeyAsUtcMidday(dateKey);
  const lunarDays = (targetDate.getTime() - KNOWN_NEW_MOON_UTC_MS) / MS_PER_DAY;
  const phaseFractionRaw = lunarDays / SYNODIC_MONTH_DAYS;
  const phaseFraction = ((phaseFractionRaw % 1) + 1) % 1;
  const phaseIndex = Math.floor(phaseFraction * PHASE_SEQUENCE.length) % PHASE_SEQUENCE.length;
  const phase = PHASE_SEQUENCE[phaseIndex] ?? 'new_moon';
  const illuminationPercent = clamp((1 - Math.cos(2 * Math.PI * phaseFraction)) * 50, 0, 100);

  return {
    phase,
    illuminationPercent: Number(illuminationPercent.toFixed(2)),
  };
}

export function resolveLunarProductivitySeverity(score: number): LunarProductivityRiskSeverity {
  if (score >= 85) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 55) return 'warn';
  return 'none';
}

export function resolveLunarProductivityImpactDirection(score: number): LunarProductivityImpactDirection | null {
  if (score <= env.LUNAR_PRODUCTIVITY_LOW_IMPACT_THRESHOLD) {
    return 'supportive';
  }
  if (score >= env.LUNAR_PRODUCTIVITY_HIGH_IMPACT_THRESHOLD) {
    return 'disruptive';
  }
  return null;
}

export function resolveLunarProductivityPushSeverity(input: {
  riskScore: number;
  riskSeverity: LunarProductivityRiskSeverity;
}): BurnoutAlertSeverity | null {
  const impactDirection = resolveLunarProductivityImpactDirection(input.riskScore);
  if (!impactDirection) return null;
  if (impactDirection === 'supportive') return 'warn';
  return input.riskSeverity === 'none' ? 'warn' : input.riskSeverity;
}

export function resolveLunarProductivityTimingSignals(transit: Pick<DailyTransitDoc, 'dateKey' | 'chart' | 'vibe'>) {
  const chart = parseChartSnapshot(transit.chart);
  const moonSignals = resolveMoonHardSignals(chart);
  const moonHouse = resolveMoonHouse(chart, transit);
  const { phase, illuminationPercent } = resolveMoonPhaseAndIllumination(transit.dateKey);
  const momentumEnergy = transit.vibe.signals?.momentum.energy ?? 0;
  const momentumFocus = transit.vibe.signals?.momentum.focus ?? 0;
  const supportiveAspectStrength = transit.vibe.signals?.positiveAspectStrength ?? 0;

  return {
    moonPhase: phase,
    illuminationPercent,
    moonHouse,
    moonHardCount: moonSignals.moonHardCount,
    moonSaturnHard: moonSignals.moonSaturnHard,
    moonMercuryHard: moonSignals.moonMercuryHard,
    supportiveAspectStrength: Number(supportiveAspectStrength.toFixed(2)),
    momentum: {
      energy: Number(momentumEnergy.toFixed(2)),
      focus: Number(momentumFocus.toFixed(2)),
    },
  } satisfies LunarProductivityTimingSignals;
}

export function calculateLunarProductivityRisk(transit: Pick<DailyTransitDoc, 'dateKey' | 'chart' | 'vibe'>) {
  const timingSignals = resolveLunarProductivityTimingSignals(transit);
  const phaseLoad =
    PHASE_LOAD_BASE[timingSignals.moonPhase] + 0.18 * Math.abs(timingSignals.illuminationPercent - 50);

  const energy = clamp(transit.vibe.metrics.energy, 0, 100);
  const focus = clamp(transit.vibe.metrics.focus, 0, 100);
  const luck = clamp(transit.vibe.metrics.luck, 0, 100);

  const riskTagContextSwitch = scoreForTag(transit.vibe.tags, 'context_switch');
  const riskTagRushBias = scoreForTag(transit.vibe.tags, 'rush_bias');

  const emotionalTide =
    4.8 * timingSignals.moonHardCount +
    8 * timingSignals.moonSaturnHard +
    5.5 * timingSignals.moonMercuryHard +
    0.75 * Math.abs(timingSignals.momentum.energy - timingSignals.momentum.focus);

  const focusResonance =
    0.62 * Math.max(0, energy - focus) +
    0.36 * Math.max(0, 60 - luck) +
    0.9 * Math.max(0, -timingSignals.momentum.focus);

  const circadianAlignment = 0.19 * riskTagContextSwitch + 0.17 * riskTagRushBias;

  const recoveryBuffer = 0.33 * timingSignals.supportiveAspectStrength + 0.24 * focus + 0.17 * luck;

  const rawRisk = 11 + phaseLoad + emotionalTide + focusResonance + circadianAlignment - recoveryBuffer;
  const riskScore = clamp(Math.round(rawRisk), 0, 100);
  const severity = resolveLunarProductivitySeverity(riskScore);

  return {
    algorithmVersion: LUNAR_PRODUCTIVITY_RISK_ALGORITHM_VERSION,
    riskScore,
    severity,
    components: {
      moonPhaseLoad: Number(phaseLoad.toFixed(2)),
      emotionalTide: Number(emotionalTide.toFixed(2)),
      focusResonance: Number(focusResonance.toFixed(2)),
      circadianAlignment: Number(circadianAlignment.toFixed(2)),
      recoveryBuffer: Number(recoveryBuffer.toFixed(2)),
    },
    signals: {
      moonPhase: timingSignals.moonPhase,
      illuminationPercent: timingSignals.illuminationPercent,
      moonHouse: timingSignals.moonHouse,
      hardAspectCount: timingSignals.moonHardCount,
      supportiveAspectStrength: timingSignals.supportiveAspectStrength,
      momentum: {
        energy: timingSignals.momentum.energy,
        focus: timingSignals.momentum.focus,
      },
    },
  };
}

function toSettingsView(doc: LunarProductivitySettingsDoc | null): LunarProductivitySettingsView {
  if (!doc) {
    return {
      ...DEFAULT_SETTINGS,
      updatedAt: null,
      source: 'default',
    };
  }

  return {
    enabled: doc.enabled,
    timezoneIana: doc.timezoneIana,
    workdayStartMinute: doc.workdayStartMinute,
    workdayEndMinute: doc.workdayEndMinute,
    quietHoursStartMinute: doc.quietHoursStartMinute,
    quietHoursEndMinute: doc.quietHoursEndMinute,
    updatedAt: doc.updatedAt.toISOString(),
    source: 'saved',
  };
}

export async function getLunarProductivitySettingsForUser(userId: ObjectId): Promise<LunarProductivitySettingsView> {
  const collections = await getCollections();
  const doc = await collections.lunarProductivitySettings.findOne({ userId });
  return toSettingsView(doc);
}

export async function upsertLunarProductivitySettingsForUser(input: {
  userId: ObjectId;
  enabled: boolean;
  timezoneIana: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
}): Promise<LunarProductivitySettingsView> {
  const collections = await getCollections();
  const now = new Date();

  const filter = { userId: input.userId };
  await collections.lunarProductivitySettings.updateOne(
    filter,
    {
      $set: {
        enabled: input.enabled,
        timezoneIana: input.timezoneIana,
        workdayStartMinute: input.workdayStartMinute,
        workdayEndMinute: input.workdayEndMinute,
        quietHoursStartMinute: input.quietHoursStartMinute,
        quietHoursEndMinute: input.quietHoursEndMinute,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true },
  );

  const saved = await collections.lunarProductivitySettings.findOne(filter);
  return toSettingsView(saved);
}

export async function getLatestLunarProductivityJobForUser(
  userId: ObjectId,
  dateKey?: string,
): Promise<LunarProductivityJobDoc | null> {
  const collections = await getCollections();
  return collections.lunarProductivityJobs.findOne(
    {
      userId,
      ...(dateKey ? { dateKey } : {}),
    },
    {
      sort: {
        updatedAt: -1,
      },
    },
  );
}

export function isLunarProductivityJobCurrentForTransit(
  job: Pick<LunarProductivityJobDoc, 'profileHash' | 'updatedAt'> | null | undefined,
  transit: Pick<DailyTransitDoc, 'profileHash' | 'generatedAt'>,
) {
  if (!job) return false;
  if (typeof job.profileHash === 'string' && job.profileHash.trim().length > 0) {
    return job.profileHash === transit.profileHash;
  }

  // Legacy jobs did not store profileHash. They are safe only if they were
  // written after the current profile transit was generated.
  return job.updatedAt.getTime() >= transit.generatedAt.getTime();
}

export async function markLunarProductivityJobSeenForUser(input: {
  userId: ObjectId;
  profileHash: string;
  dateKey: string;
  transitGeneratedAt: Date;
  riskScore: number;
  severity: BurnoutAlertSeverity;
  impactDirection: LunarProductivityImpactDirection;
  now?: Date;
}): Promise<{
  status: 'cancelled' | 'already_sent';
  job: LunarProductivityJobDoc | null;
}> {
  const collections = await getCollections();
  const now = input.now ?? new Date();
  const existingJob = await collections.lunarProductivityJobs.findOne({
    userId: input.userId,
    dateKey: input.dateKey,
  });
  const currentExistingJob = isLunarProductivityJobCurrentForTransit(existingJob, {
    profileHash: input.profileHash,
    generatedAt: input.transitGeneratedAt,
  })
    ? existingJob
    : null;

  if (existingJob?.status === 'sent') {
    return {
      status: 'already_sent',
      job: existingJob,
    };
  }

  await collections.lunarProductivityJobs.updateOne(
    { userId: input.userId, dateKey: input.dateKey },
    {
      $set: {
        profileHash: input.profileHash,
        severity: input.severity,
        riskScore: input.riskScore,
        impactDirection: input.impactDirection,
        predictedDipAt: currentExistingJob?.predictedDipAt ?? null,
        scheduledAt: null,
        status: 'cancelled',
        providerMessageId: null,
        lastError: 'viewed_in_app',
        sentAt: currentExistingJob?.sentAt ?? null,
        seenAt: now,
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
    status: 'cancelled',
    job: await collections.lunarProductivityJobs.findOne({
      userId: input.userId,
      dateKey: input.dateKey,
    }),
  };
}
