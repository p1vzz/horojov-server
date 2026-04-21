import { ObjectId } from 'mongodb';
import type { FastifyBaseLogger } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  getCollections,
  type BirthProfileDoc,
  type DailyTransitDoc,
  type DailyTransitMetricsDoc,
  type DailyTransitVibeDoc,
  type AlgorithmTagDoc,
  type MongoCollections,
} from '../db/mongo.js';
import { getCachedAiSynergyForDay, getOrCreateAiSynergyForDay, type AiSynergyView } from './aiSynergy.js';
import { runWithConcurrency } from './asyncPool.js';

const HOUSE_TYPE = 'placidus';
const DAILY_VIBE_ALGORITHM_VERSION = 'daily-vibe-v2';

const housePlanetSchema = z.object({
  name: z.string(),
  sign: z.string(),
  full_degree: z.number(),
  is_retro: z.union([z.string(), z.boolean()]).optional(),
});

const houseSchema = z.object({
  start_degree: z.number(),
  end_degree: z.number(),
  sign: z.string(),
  house_id: z.number(),
  planets: z.array(housePlanetSchema).optional(),
});

const aspectSchema = z.object({
  aspecting_planet: z.string(),
  aspected_planet: z.string(),
  type: z.string(),
  orb: z.number().optional(),
  diff: z.number().optional(),
});

const westernChartSchema = z.object({
  houses: z.array(houseSchema),
  aspects: z.array(aspectSchema),
});

const geoDetailsSchema = z.object({
  geonames: z.array(
    z.object({
      place_name: z.string().optional(),
      latitude: z.union([z.string(), z.number()]),
      longitude: z.union([z.string(), z.number()]),
      timezone_id: z.string().optional(),
    })
  ),
});

const timezoneSchema = z.object({
  timezone: z.number(),
});

type WesternChart = z.infer<typeof westernChartSchema>;
type AstrologyApiBody = Record<string, unknown>;

type TransitLocation = {
  latitude: number;
  longitude: number;
  timezoneId: string | null;
  placeName: string;
  source: 'profile_coordinates' | 'astrology_geo';
};

type DominantTransit = {
  planet: string;
  sign: string;
  house: number;
  retrograde: boolean;
};

function normalizeAstrologyBaseUrl(input: string) {
  const url = new URL(input);
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  if (normalizedPath === '' || normalizedPath === '/') {
    url.pathname = '/v1';
  } else {
    url.pathname = normalizedPath;
  }
  return url.toString().replace(/\/+$/, '');
}

function resolveAstrologyAuthHeaders(): Record<string, string> | null {
  const apiKey = env.ASTROLOGY_API_KEY?.trim();
  if (!apiKey) return null;

  if (apiKey.startsWith('ak-')) {
    return {
      'x-astrologyapi-key': apiKey,
    };
  }

  const userId = env.ASTROLOGY_USER_ID?.trim();
  if (!userId) return null;
  const auth = Buffer.from(`${userId}:${apiKey}`).toString('base64');
  return {
    Authorization: `Basic ${auth}`,
  };
}

async function callAstrologyApi<T>(
  path: string,
  body: AstrologyApiBody
): Promise<{ status: number; data: T | null; text: string }> {
  const authHeaders = resolveAstrologyAuthHeaders();
  if (!authHeaders) {
    throw new Error('Astrology API credentials are not configured');
  }

  const baseUrl = normalizeAstrologyBaseUrl(env.ASTROLOGY_URL);

  const response = await fetch(`${baseUrl}/${path}`, {
    method: 'POST',
    headers: {
      ...authHeaders,
      'Content-Type': 'application/json',
      'Accept-Language': 'en',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(12_000),
  });

  const text = await response.text();
  let parsed: T | null = null;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    parsed = null;
  }

  return { status: response.status, data: parsed, text };
}

function buildGeoQueryCandidates(cityInput: string) {
  const normalized = cityInput.trim();
  const byComma = normalized
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

  const candidates = [normalized, byComma[0], byComma.slice(0, 2).join(' '), byComma.join(' ')].filter(
    (value): value is string => !!value && value.length >= 2
  );
  return [...new Set(candidates)];
}

function toFloat(value: string | number) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function normalizeCoordinate(value: number | null | undefined) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Number(value.toFixed(6));
}

function parseRetro(value: string | boolean | undefined) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'retrograde' || normalized === 'retro' || normalized === 'r' || normalized === 'rx';
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function shiftDateKey(date: Date, deltaDays: number) {
  const shifted = new Date(date);
  shifted.setDate(shifted.getDate() + deltaDays);
  return toDateKey(shifted);
}

function transitDateParts(date: Date) {
  return {
    day: date.getDate(),
    month: date.getMonth() + 1,
    year: date.getFullYear(),
  };
}

function providerDateString(date: Date) {
  const { day, month, year } = transitDateParts(date);
  return `${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}-${year}`;
}

function clampScore(value: number) {
  return Math.max(10, Math.min(99, Math.round(value)));
}

function clampFloat(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function houseWeight(houseId: number) {
  const weights: Record<number, number> = {
    1: 7,
    2: 5,
    3: 4,
    4: 3,
    5: 4,
    6: 6,
    7: 5,
    8: 3,
    9: 4,
    10: 8,
    11: 4,
    12: 2,
  };
  return weights[houseId] ?? 3;
}

function planetWeight(name: string) {
  const key = name.trim().toLowerCase();
  const weights: Record<string, number> = {
    sun: 8,
    moon: 7,
    mercury: 6,
    venus: 6,
    mars: 8,
    jupiter: 7,
    saturn: 6,
    uranus: 5,
    neptune: 4,
    pluto: 5,
  };
  return weights[key] ?? 4;
}

function normalizePlanetName(name: string) {
  return name.trim().toLowerCase();
}

function normalizeSignName(sign: string) {
  return sign.trim().toLowerCase();
}

function planetPhaseWeight(planet: string) {
  const normalized = normalizePlanetName(planet);
  const weights: Record<string, number> = {
    mercury: 4.4,
    venus: 3.4,
    mars: 3.8,
    jupiter: 2.4,
    saturn: 2.2,
    uranus: 1.7,
    neptune: 1.5,
    pluto: 1.6,
    moon: 2.8,
    sun: 2.5,
  };
  return weights[normalized] ?? 2;
}

function planetDignityDelta(planet: string, sign: string) {
  const planetKey = normalizePlanetName(planet);
  const signKey = normalizeSignName(sign);
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
  const exaltation: Record<string, string[]> = {
    sun: ['aries'],
    moon: ['taurus'],
    mercury: ['virgo'],
    venus: ['pisces'],
    mars: ['capricorn'],
    jupiter: ['cancer'],
    saturn: ['libra'],
  };
  const fall: Record<string, string[]> = {
    sun: ['libra'],
    moon: ['scorpio'],
    mercury: ['pisces'],
    venus: ['virgo'],
    mars: ['cancer'],
    jupiter: ['capricorn'],
    saturn: ['aries'],
  };

  let score = 0;
  if ((domicile[planetKey] ?? []).includes(signKey)) score += 3.6;
  if ((exaltation[planetKey] ?? []).includes(signKey)) score += 2.2;
  if ((detriment[planetKey] ?? []).includes(signKey)) score -= 2.6;
  if ((fall[planetKey] ?? []).includes(signKey)) score -= 2;
  return score;
}

function aspectStrength(chart: WesternChart) {
  let positiveCount = 0;
  let hardCount = 0;
  let positiveStrength = 0;
  let hardStrength = 0;

  for (const aspect of chart.aspects) {
    const type = aspect.type.toLowerCase();
    const orb = typeof aspect.orb === 'number'
      ? Math.abs(aspect.orb)
      : typeof aspect.diff === 'number'
        ? Math.abs(aspect.diff)
        : null;

    const resolveMultiplier = (maxOrb: number, base: number) => {
      if (orb === null) return base * 0.72;
      const normalized = clampFloat(1 - Math.min(orb, maxOrb) / maxOrb, 0.12, 1);
      return base * normalized;
    };

    if (type.includes('trine')) {
      positiveCount += 1;
      positiveStrength += resolveMultiplier(8, 1.2);
      continue;
    }
    if (type.includes('sextile')) {
      positiveCount += 1;
      positiveStrength += resolveMultiplier(6, 0.92);
      continue;
    }
    if (type.includes('square')) {
      hardCount += 1;
      hardStrength += resolveMultiplier(7, 1.12);
      continue;
    }
    if (type.includes('opposition')) {
      hardCount += 1;
      hardStrength += resolveMultiplier(8, 1.28);
      continue;
    }
    if (type.includes('quincunx')) {
      hardCount += 1;
      hardStrength += resolveMultiplier(5, 0.96);
    }
  }

  return {
    positiveCount,
    hardCount,
    positiveStrength: Number(positiveStrength.toFixed(2)),
    hardStrength: Number(hardStrength.toFixed(2)),
  };
}

function modeLabelForTransit(dominant: DominantTransit) {
  if (dominant.house === 10 || dominant.house === 1) return 'High Execution Mode';
  if (dominant.house === 6) return 'System Optimization Mode';
  if (dominant.house === 2 || dominant.house === 8) return 'Resource Strategy Mode';
  if (dominant.house === 3 || dominant.house === 9) return 'Communication Push Mode';
  if (dominant.house === 7 || dominant.house === 11) return 'Collaboration Momentum';
  if (dominant.house === 5) return 'Creative Momentum Mode';
  return 'Steady Progress Mode';
}

function ordinalHouse(house: number) {
  if (house === 1) return '1st';
  if (house === 2) return '2nd';
  if (house === 3) return '3rd';
  return `${house}th`;
}

function buildDailyVibe(chart: WesternChart, previousMetrics: DailyTransitMetricsDoc | null): DailyTransitVibeDoc {
  const transitPlanets = chart.houses.flatMap((house) =>
    (house.planets ?? []).map((planet) => {
      const retrograde = parseRetro(planet.is_retro);
      const dignity = planetDignityDelta(planet.name, planet.sign);
      const phaseWeight = planetPhaseWeight(planet.name);
      return {
        planet: planet.name,
        sign: planet.sign,
        house: house.house_id,
        retrograde,
        dignity,
        phaseWeight,
        score:
          houseWeight(house.house_id) +
          planetWeight(planet.name) +
          (retrograde ? -1.2 : 1.1) +
          dignity * 0.72 +
          phaseWeight * 0.18,
      };
    })
  );

  const dominant = transitPlanets.sort((a, b) => b.score - a.score)[0] ?? {
    planet: 'Sun',
    sign: chart.houses[0]?.sign ?? 'Aries',
    house: 1,
    retrograde: false,
    dignity: 0,
    phaseWeight: 2.5,
    score: 0,
  };

  const houseDensity = new Map<number, number>();
  for (const placement of transitPlanets) {
    houseDensity.set(placement.house, (houseDensity.get(placement.house) ?? 0) + 1);
  }
  const secondaryHouseEntry = [...houseDensity.entries()]
    .filter(([houseId]) => houseId !== dominant.house)
    .sort((a, b) => b[1] - a[1] || houseWeight(b[0]) - houseWeight(a[0]))[0] ?? null;
  const secondaryHouse = secondaryHouseEntry?.[0] ?? null;
  const secondaryDensity = secondaryHouseEntry?.[1] ?? 0;
  const secondaryHouseBoost =
    secondaryHouse === null
      ? 0
      : secondaryDensity * 0.9 + houseWeight(secondaryHouse) * 0.33 + (secondaryHouse === 3 || secondaryHouse === 11 ? 1.6 : 0);

  const aspectSignal = aspectStrength(chart);
  const phaseBoost = dominant.retrograde ? -(2 + dominant.phaseWeight * 0.42) : 1 + dominant.phaseWeight * 0.36;

  const baseEnergy =
    53 +
    houseWeight(dominant.house) * 1.95 +
    planetWeight(dominant.planet) * 1.15 +
    aspectSignal.positiveStrength * 1.82 -
    aspectSignal.hardStrength * 2.08 +
    dominant.dignity * 0.9 +
    phaseBoost * 0.54 +
    secondaryHouseBoost * 0.72;

  const baseFocus =
    49 +
    (dominant.house === 6 || dominant.house === 10 ? 15 : 6.5) +
    (dominant.retrograde ? -5.4 : 2.9) +
    aspectSignal.positiveStrength * 1.3 -
    aspectSignal.hardStrength * 1.72 +
    dominant.dignity * 1.08 +
    (dominant.retrograde ? -dominant.phaseWeight * 0.7 : dominant.phaseWeight * 0.56) +
    secondaryHouseBoost * 0.5;

  const baseLuck =
    47 +
    (normalizePlanetName(dominant.planet) === 'jupiter' || normalizePlanetName(dominant.planet) === 'venus' ? 11.5 : 4.3) +
    aspectSignal.positiveStrength * 2.08 -
    aspectSignal.hardStrength * 1.24 +
    dominant.dignity * 0.72 +
    phaseBoost * 0.4 +
    secondaryHouseBoost * 0.44;

  const momentum = {
    energy: previousMetrics ? clampFloat((baseEnergy - previousMetrics.energy) * 0.18, -6, 6) : 0,
    focus: previousMetrics ? clampFloat((baseFocus - previousMetrics.focus) * 0.16, -6, 6) : 0,
    luck: previousMetrics ? clampFloat((baseLuck - previousMetrics.luck) * 0.14, -5, 5) : 0,
  };

  const metrics = {
    energy: clampScore(baseEnergy + momentum.energy),
    focus: clampScore(baseFocus + momentum.focus),
    luck: clampScore(baseLuck + momentum.luck),
  };

  const modeLabel = modeLabelForTransit(dominant);
  const summary =
    `Transit ${dominant.planet} in your ${ordinalHouse(dominant.house)} house sets a ${modeLabel.toLowerCase()} tone. ` +
    `Balance deep execution with collaboration windows as aspect pressure shifts through the day.`;

  const tags: AlgorithmTagDoc[] = [
    {
      group: 'work_mode',
      label: 'execution',
      score: clampPercent(metrics.energy * 0.44 + metrics.focus * 0.42 + (dominant.house === 10 || dominant.house === 1 ? 12 : 4)),
      reason: 'Energy and focus are aligned with leadership-oriented houses.',
    },
    {
      group: 'work_mode',
      label: 'strategy',
      score: clampPercent(metrics.focus * 0.56 + metrics.luck * 0.25 + (secondaryHouse === 9 ? 8 : 3)),
      reason: 'Focus quality and secondary house context favor structured planning.',
    },
    {
      group: 'timing',
      label: 'deep_work_window',
      score: clampPercent(metrics.focus * 0.74 + aspectSignal.positiveStrength * 4 - aspectSignal.hardStrength * 3),
      reason: 'Positive aspect strength improves concentration windows.',
    },
    {
      group: 'timing',
      label: 'collab_window',
      score: clampPercent(metrics.luck * 0.62 + (dominant.house === 7 || dominant.house === 11 ? 14 : 4) - aspectSignal.hardStrength * 1.6),
      reason: 'Social houses and luck indicate collaboration quality.',
    },
    {
      group: 'risk',
      label: 'context_switch',
      score: clampPercent(42 + aspectSignal.hardStrength * 5.8 - metrics.focus * 0.28 + secondaryDensity * 4),
      reason: 'Hard aspects and multi-house activity increase fragmentation risk.',
    },
    {
      group: 'risk',
      label: 'rush_bias',
      score: clampPercent(38 + metrics.energy * 0.35 - metrics.focus * 0.22 + (dominant.retrograde ? 9 : 1)),
      reason: 'High drive under pressure can outpace validation discipline.',
    },
  ];

  const balanceSignal = Number((aspectSignal.positiveStrength - aspectSignal.hardStrength).toFixed(2));
  const drivers = [
    `${dominant.planet} in ${ordinalHouse(dominant.house)} house amplifies ${modeLabel.toLowerCase()}.`,
    `Aspect balance is ${balanceSignal >= 0 ? 'supportive' : 'challenging'} (${aspectSignal.positiveStrength.toFixed(1)} vs ${aspectSignal.hardStrength.toFixed(1)}).`,
    secondaryHouse === null
      ? 'Transit concentration is focused, reducing context spread.'
      : `Secondary emphasis in ${ordinalHouse(secondaryHouse)} house adds a parallel priority stream.`,
  ];

  const cautions = [
    dominant.retrograde
      ? `Retrograde motion in ${dominant.planet} can slow response loops; avoid rapid context shifts.`
      : 'Maintain quality checkpoints so speed does not outrun validation.',
    aspectSignal.hardCount > aspectSignal.positiveCount
      ? 'Hard aspects dominate today; break decisions into short review cycles.'
      : 'Supportive aspects are stronger, but keep final approvals explicit.',
    Math.abs(momentum.focus) > 3
      ? 'Focus momentum is volatile compared to yesterday; protect deep-work blocks.'
      : 'Momentum is stable; prioritize one high-value sequence before multitasking.',
  ];

  return {
    algorithmVersion: DAILY_VIBE_ALGORITHM_VERSION,
    title: `${dominant.planet} in ${ordinalHouse(dominant.house)} House`,
    modeLabel,
    summary,
    dominant: {
      planet: dominant.planet,
      sign: dominant.sign,
      house: dominant.house,
      retrograde: dominant.retrograde,
    },
    metrics,
    signals: {
      positiveAspects: aspectSignal.positiveCount,
      hardAspects: aspectSignal.hardCount,
      positiveAspectStrength: Number(aspectSignal.positiveStrength.toFixed(2)),
      hardAspectStrength: Number(aspectSignal.hardStrength.toFixed(2)),
      dominantScore: Number(dominant.score.toFixed(2)),
      secondaryHouse,
      secondaryHouseDensity: secondaryDensity,
      dignityBalance: Number(dominant.dignity.toFixed(2)),
      momentum: {
        energy: Number(momentum.energy.toFixed(2)),
        focus: Number(momentum.focus.toFixed(2)),
        luck: Number(momentum.luck.toFixed(2)),
      },
    },
    tags,
    drivers,
    cautions,
  };
}

async function resolveLocation(profile: BirthProfileDoc, logger: FastifyBaseLogger): Promise<TransitLocation> {
  const latitude = normalizeCoordinate(profile.latitude ?? null);
  const longitude = normalizeCoordinate(profile.longitude ?? null);

  if (latitude !== null && longitude !== null) {
    return {
      latitude,
      longitude,
      timezoneId: null,
      placeName: profile.city,
      source: 'profile_coordinates',
    };
  }

  const geoCandidates = buildGeoQueryCandidates(profile.city);
  for (const candidate of geoCandidates) {
    const geoResponse = await callAstrologyApi<unknown>('geo_details', {
      place: candidate,
      maxRows: 1,
    });

    if (geoResponse.status !== 200 || !geoResponse.data) {
      logger.warn(
        { candidate, status: geoResponse.status, body: geoResponse.text.slice(0, 180) },
        'daily transit geo_details candidate failed'
      );
      continue;
    }

    const geoParsed = geoDetailsSchema.safeParse(geoResponse.data);
    if (!geoParsed.success) {
      logger.warn({ candidate, issues: geoParsed.error.issues }, 'daily transit geo_details validation failed');
      continue;
    }

    if (geoParsed.data.geonames.length === 0) continue;
    const location = geoParsed.data.geonames[0];
    if (!location) continue;
    const lat = toFloat(location.latitude);
    const lon = toFloat(location.longitude);

    if (lat === null || lon === null) {
      throw new Error('Invalid location coordinates received from astrology provider');
    }

    return {
      latitude: lat,
      longitude: lon,
      timezoneId: location.timezone_id ?? null,
      placeName: location.place_name ?? profile.city,
      source: 'astrology_geo',
    };
  }

  throw new Error(`Birth city could not be resolved for transit generation: ${profile.city}`);
}

async function resolveTimezone(latitude: number, longitude: number, date: Date, logger: FastifyBaseLogger) {
  const timezoneResponse = await callAstrologyApi<unknown>('timezone_with_dst', {
    latitude,
    longitude,
    date: providerDateString(date),
  });

  if (timezoneResponse.status !== 200 || !timezoneResponse.data) {
    logger.error(
      { status: timezoneResponse.status, body: timezoneResponse.text.slice(0, 280) },
      'daily transit timezone_with_dst failed'
    );
    throw new Error('Unable to resolve timezone for daily transit');
  }

  const timezoneParsed = timezoneSchema.safeParse(timezoneResponse.data);
  if (!timezoneParsed.success) {
    logger.error({ issues: timezoneParsed.error.issues }, 'daily transit timezone payload validation failed');
    throw new Error('Unexpected timezone payload for daily transit');
  }

  return timezoneParsed.data.timezone;
}

async function fetchTransitChart(latitude: number, longitude: number, timezone: number, date: Date, logger: FastifyBaseLogger) {
  const parts = transitDateParts(date);
  const chartResponse = await callAstrologyApi<unknown>('western_chart_data', {
    day: parts.day,
    month: parts.month,
    year: parts.year,
    hour: 0,
    min: 0,
    lat: latitude,
    lon: longitude,
    tzone: timezone,
    house_type: HOUSE_TYPE,
  });

  if (chartResponse.status !== 200 || !chartResponse.data) {
    logger.error(
      { status: chartResponse.status, body: chartResponse.text.slice(0, 280) },
      'daily transit western_chart_data failed'
    );
    throw new Error('Unable to generate daily transit chart');
  }

  const parsed = westernChartSchema.safeParse(chartResponse.data);
  if (!parsed.success) {
    logger.error({ issues: parsed.error.issues }, 'daily transit chart payload validation failed');
    throw new Error('Unexpected chart payload for daily transit');
  }

  return parsed.data;
}

type EnsureTransitResult = {
  doc: DailyTransitDoc;
  cached: boolean;
  aiSynergy: AiSynergyView | null;
};

type EnsureTransitOptions = {
  includeAiSynergy?: boolean;
  aiSynergyMode?: 'sync' | 'cache-only' | 'none';
};

export function resolveDailyTransitAiSynergyMode(options: EnsureTransitOptions = {}) {
  if (options.aiSynergyMode) return options.aiSynergyMode;
  return options.includeAiSynergy === false ? 'none' : 'sync';
}

async function ensureAiSynergyForTransit(
  profile: BirthProfileDoc,
  dateKey: string,
  doc: Pick<DailyTransitDoc, 'chart' | 'vibe'>,
  collections: MongoCollections,
  logger: FastifyBaseLogger
) {
  try {
    const result = await getOrCreateAiSynergyForDay({
      userId: profile.userId,
      profileHash: profile.profileHash,
      dateKey,
      transitChart: doc.chart,
      transitVibe: doc.vibe,
      collections,
    });
    return result.item;
  } catch (error) {
    logger.warn(
      {
        error,
        userId: profile.userId.toHexString(),
        dateKey,
      },
      'ai synergy generation skipped'
    );
    return null;
  }
}

async function getCachedAiSynergyForTransit(
  profile: BirthProfileDoc,
  dateKey: string,
  collections: MongoCollections,
  logger: FastifyBaseLogger
) {
  try {
    return await getCachedAiSynergyForDay({
      userId: profile.userId,
      profileHash: profile.profileHash,
      dateKey,
      collections,
    });
  } catch (error) {
    logger.warn(
      {
        error,
        userId: profile.userId.toHexString(),
        dateKey,
      },
      'cached ai synergy lookup skipped'
    );
    return null;
  }
}

async function resolveAiSynergyForTransit(
  mode: ReturnType<typeof resolveDailyTransitAiSynergyMode>,
  profile: BirthProfileDoc,
  dateKey: string,
  doc: Pick<DailyTransitDoc, 'chart' | 'vibe'>,
  collections: MongoCollections,
  logger: FastifyBaseLogger
) {
  if (mode === 'none') return null;
  if (mode === 'cache-only') {
    return getCachedAiSynergyForTransit(profile, dateKey, collections, logger);
  }

  return ensureAiSynergyForTransit(profile, dateKey, doc, collections, logger);
}

async function ensureDailyTransitForProfile(
  profile: BirthProfileDoc,
  date: Date,
  logger: FastifyBaseLogger,
  collections: MongoCollections,
  options: EnsureTransitOptions = {}
): Promise<EnsureTransitResult> {
  const aiSynergyMode = resolveDailyTransitAiSynergyMode(options);
  const dateKey = toDateKey(date);
  const existing = await collections.dailyTransits.findOne({
    userId: profile.userId,
    profileHash: profile.profileHash,
    dateKey,
  });

  if (existing?.vibe?.algorithmVersion === DAILY_VIBE_ALGORITHM_VERSION) {
    const aiSynergy = await resolveAiSynergyForTransit(
      aiSynergyMode,
      profile,
      dateKey,
      existing,
      collections,
      logger
    );
    return { doc: existing, cached: true, aiSynergy };
  }

  const previousDateKey = shiftDateKey(date, -1);
  const previousDailyTransit = await collections.dailyTransits.findOne({
    userId: profile.userId,
    profileHash: profile.profileHash,
    dateKey: previousDateKey,
  }, {
    projection: {
      'vibe.metrics': 1,
    },
  });
  const previousMetrics = previousDailyTransit?.vibe?.metrics ?? null;

  const location = await resolveLocation(profile, logger);
  const timezone = await resolveTimezone(location.latitude, location.longitude, date, logger);
  const chart = await fetchTransitChart(location.latitude, location.longitude, timezone, date, logger);
  const vibe = buildDailyVibe(chart, previousMetrics);
  const now = new Date();

  const doc: DailyTransitDoc = {
    _id: new ObjectId(),
    userId: profile.userId,
    profileHash: profile.profileHash,
    dateKey,
    chart,
    vibe,
    meta: {
      latitude: location.latitude,
      longitude: location.longitude,
      timezone,
      timezoneId: location.timezoneId,
      source: location.source,
      placeName: location.placeName,
    },
    generatedAt: now,
    createdAt: now,
    updatedAt: now,
  };

  await collections.dailyTransits.updateOne(
    {
      userId: profile.userId,
      profileHash: profile.profileHash,
      dateKey,
    },
    {
      $set: {
        chart: doc.chart,
        vibe: doc.vibe,
        meta: doc.meta,
        generatedAt: doc.generatedAt,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: doc._id,
        createdAt: now,
      },
    },
    { upsert: true }
  );

  const aiSynergy = await resolveAiSynergyForTransit(
    aiSynergyMode,
    profile,
    dateKey,
    doc,
    collections,
    logger
  );
  return { doc, cached: false, aiSynergy };
}

export async function getOrCreateDailyTransitForUser(
  userId: ObjectId,
  date: Date,
  logger: FastifyBaseLogger,
  options: EnsureTransitOptions = {}
): Promise<EnsureTransitResult> {
  const collections = await getCollections();
  const profile = await collections.birthProfiles.findOne(
    { userId },
    {
      projection: {
        _id: 1,
        userId: 1,
        profileHash: 1,
        city: 1,
        latitude: 1,
        longitude: 1,
      },
    }
  );
  if (!profile) {
    throw new Error('Birth profile not found');
  }

  return ensureDailyTransitForProfile(profile, date, logger, collections, options);
}

export async function generateDailyTransitsForAllUsers(date: Date, logger: FastifyBaseLogger) {
  const collections = await getCollections();
  const profiles = await collections.birthProfiles
    .find(
      {},
      {
        projection: {
          _id: 1,
          userId: 1,
          profileHash: 1,
          city: 1,
          latitude: 1,
          longitude: 1,
        },
      }
    )
    .toArray();
  const concurrency = Math.max(
    1,
    Math.min(env.DAILY_TRANSIT_SCHEDULER_CONCURRENCY, profiles.length || 1)
  );

  let generated = 0;
  let cached = 0;
  let failed = 0;

  await runWithConcurrency(profiles, concurrency, async (profile) => {
    try {
      const result = await ensureDailyTransitForProfile(profile, date, logger, collections);
      if (result.cached) {
        cached += 1;
      } else {
        generated += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error(
        { error, userId: profile.userId.toHexString(), city: profile.city },
        'daily transit generation failed for user'
      );
    }
  });

  return {
    dateKey: toDateKey(date),
    totalProfiles: profiles.length,
    generated,
    cached,
    failed,
  };
}

export function toDailyTransitResponse(result: EnsureTransitResult) {
  const { doc, cached } = result;
  return {
    dateKey: doc.dateKey,
    cached,
    generatedAt: doc.generatedAt.toISOString(),
    transit: {
      algorithmVersion: doc.vibe.algorithmVersion,
      title: doc.vibe.title,
      modeLabel: doc.vibe.modeLabel,
      summary: doc.vibe.summary,
      dominant: doc.vibe.dominant,
      metrics: doc.vibe.metrics,
      signals: doc.vibe.signals,
      tags: doc.vibe.tags,
      drivers: doc.vibe.drivers,
      cautions: doc.vibe.cautions,
    },
    meta: {
      placeName: doc.meta.placeName,
      source: doc.meta.source,
      timezone: doc.meta.timezone,
    },
    aiSynergy: result.aiSynergy,
  };
}

export function buildTodayDate() {
  return new Date();
}
