import { ObjectId } from 'mongodb';
import { z } from 'zod';
import {
  getCollections,
  type BurnoutAlertJobDoc,
  type BurnoutAlertSettingsDoc,
  type BurnoutAlertSeverity,
  type DailyTransitDoc,
  type PushNotificationTokenDoc,
  type PushTokenPlatform,
} from '../db/mongo.js';

export const BURNOUT_RISK_ALGORITHM_VERSION = 'burnout-risk-v1';
export const BURNOUT_TIMING_ALGORITHM_VERSION = 'burnout-timing-v1';

export type BurnoutRiskSeverity = 'none' | BurnoutAlertSeverity;

export type BurnoutAlertSettingsView = {
  enabled: boolean;
  timezoneIana: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  updatedAt: string | null;
  source: 'default' | 'saved';
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
                is_retro: z.union([z.string(), z.boolean()]).optional(),
              })
            )
            .optional(),
        })
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
        })
      )
      .default([]),
  })
  .passthrough();

const DEFAULT_SETTINGS: Omit<BurnoutAlertSettingsView, 'updatedAt' | 'source'> = {
  enabled: false,
  timezoneIana: 'America/New_York',
  workdayStartMinute: 540,
  workdayEndMinute: 1230,
  quietHoursStartMinute: 1290,
  quietHoursEndMinute: 480,
};

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function normalizePlanetName(value: string) {
  return value.trim().toLowerCase();
}

function parseRetro(value: string | boolean | undefined) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'retrograde' || normalized === 'retro' || normalized === 'r' || normalized === 'rx';
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

function resolveHousePressureForSaturn(house: number | null) {
  if (house === 12) return 14;
  if (house === 10) return 12;
  if (house === 6) return 10;
  if (house === 8) return 8;
  if (house === 1) return 6;
  return 4;
}

function resolveHousePressureForMoon(house: number | null) {
  if (house === 12) return 12;
  if (house === 8) return 10;
  if (house === 6) return 9;
  if (house === 10) return 8;
  if (house === 3) return 7;
  return 4;
}

function parseChartSnapshot(input: unknown) {
  const parsed = chartSnapshotSchema.safeParse(input);
  if (!parsed.success) return null;
  return parsed.data;
}

function resolvePlanetPlacement(chart: ReturnType<typeof parseChartSnapshot>, planet: string) {
  if (!chart) return { house: null as number | null, retrograde: false };
  const target = normalizePlanetName(planet);
  for (const house of chart.houses) {
    for (const body of house.planets ?? []) {
      if (normalizePlanetName(body.name) === target) {
        return {
          house: Number.isFinite(house.house_id) ? house.house_id : null,
          retrograde: parseRetro(body.is_retro),
        };
      }
    }
  }
  return { house: null as number | null, retrograde: false };
}

function resolveSaturnMoonHardSignals(chart: ReturnType<typeof parseChartSnapshot>) {
  if (!chart) {
    return {
      saturnHardCount: 0,
      moonHardCount: 0,
      saturnMoonHard: 0,
    };
  }

  let saturnHardCount = 0;
  let moonHardCount = 0;
  let saturnMoonHard = 0;

  for (const aspect of chart.aspects) {
    if (!isHardAspectType(aspect.type)) continue;
    const left = normalizePlanetName(aspect.aspecting_planet);
    const right = normalizePlanetName(aspect.aspected_planet);
    const weight = orbWeight(aspect.type, resolveAspectOrb(aspect));

    const hasSaturn = left === 'saturn' || right === 'saturn';
    const hasMoon = left === 'moon' || right === 'moon';

    if (hasSaturn) saturnHardCount += weight;
    if (hasMoon) moonHardCount += weight;
    if (hasSaturn && hasMoon) saturnMoonHard = Math.max(saturnMoonHard, weight);
  }

  return {
    saturnHardCount: Number(saturnHardCount.toFixed(2)),
    moonHardCount: Number(moonHardCount.toFixed(2)),
    saturnMoonHard: Number(saturnMoonHard.toFixed(2)),
  };
}

export function resolveBurnoutSeverity(score: number): BurnoutRiskSeverity {
  if (score >= 85) return 'critical';
  if (score >= 70) return 'high';
  if (score >= 55) return 'warn';
  return 'none';
}

export function calculateBurnoutRisk(transit: Pick<DailyTransitDoc, 'chart' | 'vibe'>) {
  const chart = parseChartSnapshot(transit.chart);
  const saturnPlacement = resolvePlanetPlacement(chart, 'saturn');
  const moonPlacement = resolvePlanetPlacement(chart, 'moon');
  const saturnMoonSignals = resolveSaturnMoonHardSignals(chart);

  const dominantPlanet = normalizePlanetName(transit.vibe.dominant.planet);
  const dominantHouse = Number.isFinite(transit.vibe.dominant.house) ? transit.vibe.dominant.house : null;

  const saturnHouse = saturnPlacement.house ?? (dominantPlanet === 'saturn' ? dominantHouse : null);
  const moonHouse = moonPlacement.house ?? (dominantPlanet === 'moon' ? dominantHouse : null);

  const saturnRetrograde = saturnPlacement.house !== null ? saturnPlacement.retrograde : dominantPlanet === 'saturn' && transit.vibe.dominant.retrograde;

  const momentumEnergy = transit.vibe.signals?.momentum.energy ?? 0;
  const momentumFocus = transit.vibe.signals?.momentum.focus ?? 0;
  const positiveAspectStrength = transit.vibe.signals?.positiveAspectStrength ?? 0;

  const energy = clamp(transit.vibe.metrics.energy, 0, 100);
  const focus = clamp(transit.vibe.metrics.focus, 0, 100);
  const luck = clamp(transit.vibe.metrics.luck, 0, 100);

  const riskTagContextSwitch = scoreForTag(transit.vibe.tags, 'context_switch');
  const riskTagRushBias = scoreForTag(transit.vibe.tags, 'rush_bias');

  const saturnLoad =
    20 * (dominantPlanet === 'saturn' ? 1 : 0) +
    12 * (saturnRetrograde ? 1 : 0) +
    7 * saturnMoonSignals.saturnMoonHard +
    4 * saturnMoonSignals.saturnHardCount +
    resolveHousePressureForSaturn(saturnHouse);

  const moonLoad =
    16 * (dominantPlanet === 'moon' ? 1 : 0) +
    3.5 * saturnMoonSignals.moonHardCount +
    5 * saturnMoonSignals.saturnMoonHard +
    resolveHousePressureForMoon(moonHouse) +
    0.9 * Math.abs(momentumEnergy - momentumFocus);

  const workloadMismatch =
    0.65 * Math.max(0, energy - focus) +
    0.4 * Math.max(0, 60 - luck) +
    1.1 * Math.max(0, -momentumFocus);

  const tagPressure = 0.2 * riskTagContextSwitch + 0.16 * riskTagRushBias;

  const recoveryBuffer = 0.35 * positiveAspectStrength + 0.22 * focus + 0.18 * luck;

  const rawRisk = 12 + saturnLoad + moonLoad + workloadMismatch + tagPressure - recoveryBuffer;
  const riskScore = clamp(Math.round(rawRisk), 0, 100);
  const severity = resolveBurnoutSeverity(riskScore);

  return {
    algorithmVersion: BURNOUT_RISK_ALGORITHM_VERSION,
    riskScore,
    severity,
    components: {
      saturnLoad: Number(saturnLoad.toFixed(2)),
      moonLoad: Number(moonLoad.toFixed(2)),
      workloadMismatch: Number(workloadMismatch.toFixed(2)),
      tagPressure: Number(tagPressure.toFixed(2)),
      recoveryBuffer: Number(recoveryBuffer.toFixed(2)),
    },
    signals: {
      saturnHardCount: saturnMoonSignals.saturnHardCount,
      moonHardCount: saturnMoonSignals.moonHardCount,
      saturnMoonHard: saturnMoonSignals.saturnMoonHard,
      riskTagContextSwitch,
      riskTagRushBias,
      positiveAspectStrength: Number(positiveAspectStrength.toFixed(2)),
      momentum: {
        energy: Number(momentumEnergy.toFixed(2)),
        focus: Number(momentumFocus.toFixed(2)),
      },
      saturn: {
        house: saturnHouse,
        retrograde: saturnRetrograde,
      },
      moon: {
        house: moonHouse,
      },
    },
  };
}

export function isValidIanaTimezone(timezoneIana: string) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezoneIana }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function toSettingsView(doc: BurnoutAlertSettingsDoc | null): BurnoutAlertSettingsView {
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

export function defaultBurnoutAlertSettings() {
  return {
    ...DEFAULT_SETTINGS,
  };
}

export async function getBurnoutAlertSettingsForUser(userId: ObjectId): Promise<BurnoutAlertSettingsView> {
  const collections = await getCollections();
  const doc = await collections.burnoutAlertSettings.findOne({ userId });
  return toSettingsView(doc);
}

export async function upsertBurnoutAlertSettingsForUser(input: {
  userId: ObjectId;
  enabled: boolean;
  timezoneIana: string;
  workdayStartMinute: number;
  workdayEndMinute: number;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
}): Promise<BurnoutAlertSettingsView> {
  const collections = await getCollections();
  const now = new Date();

  const filter = { userId: input.userId };
  await collections.burnoutAlertSettings.updateOne(
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
    { upsert: true }
  );

  const saved = await collections.burnoutAlertSettings.findOne(filter);
  return toSettingsView(saved);
}

export async function upsertPushNotificationTokenForUser(input: {
  userId: ObjectId;
  token: string;
  platform: PushTokenPlatform;
  appVersion: string | null;
}): Promise<Pick<PushNotificationTokenDoc, 'platform' | 'active' | 'updatedAt' | 'lastSeenAt'>> {
  const collections = await getCollections();
  const now = new Date();

  await collections.pushNotificationTokens.updateOne(
    { token: input.token },
    {
      $set: {
        userId: input.userId,
        token: input.token,
        platform: input.platform,
        appVersion: input.appVersion,
        active: true,
        lastSeenAt: now,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true }
  );

  const saved = await collections.pushNotificationTokens.findOne({ token: input.token });
  return {
    platform: saved?.platform ?? input.platform,
    active: saved?.active ?? true,
    updatedAt: saved?.updatedAt ?? now,
    lastSeenAt: saved?.lastSeenAt ?? now,
  };
}

export async function getLatestBurnoutAlertJobForUser(userId: ObjectId): Promise<BurnoutAlertJobDoc | null> {
  const collections = await getCollections();
  return collections.burnoutAlertJobs.findOne(
    { userId },
    {
      sort: {
        updatedAt: -1,
      },
    }
  );
}
