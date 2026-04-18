import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { env } from '../../config/env.js';
import {
  getCollections,
  type FullNatalCareerAnalysisPayloadDoc,
} from '../../db/mongo.js';
import type { ChartPromptPayload } from '../careerInsights.js';
import {
  generateFullNatalCareerAnalysis,
  getFullNatalAnalysisConfig,
} from '../fullNatalAnalysis.js';

export const natalChartRequestSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  birthDate: z
    .string()
    .trim()
    .regex(/^\d{2}\/\d{2}\/\d{4}$/),
  birthTime: z
    .string()
    .trim()
    .regex(/^\d{2}:\d{2}$/)
    .nullable(),
  unknownTime: z.boolean().default(false),
  city: z.string().trim().min(2).max(160),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  country: z.string().trim().min(2).max(120).nullable().optional(),
  admin1: z.string().trim().min(1).max(120).nullable().optional(),
});

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

export const westernChartSchema = z.object({
  houses: z.array(houseSchema),
  aspects: z.array(aspectSchema),
});

export const geoDetailsSchema = z.object({
  geonames: z.array(
    z.object({
      place_name: z.string().optional(),
      latitude: z.union([z.string(), z.number()]),
      longitude: z.union([z.string(), z.number()]),
      timezone_id: z.string().optional(),
    }),
  ),
});

export const timezoneSchema = z.object({
  timezone: z.number(),
});

export type NatalInput = z.infer<typeof natalChartRequestSchema>;
export type WesternChart = z.infer<typeof westernChartSchema>;
type AstrologyApiBody = Record<string, unknown>;

export const HOUSE_TYPE = "placidus";
export const MIN_CAREER_INSIGHTS = 3;
export const MAX_CAREER_INSIGHTS = 5;

const queryBooleanSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off", ""].includes(normalized)) return false;
  return value;
}, z.boolean()).default(false);

export const careerInsightsQuerySchema = z.object({
  tier: z.enum(["free", "premium"]).default("free"),
  regenerate: z.coerce.boolean().default(false),
});

export const discoverRolesQuerySchema = z.object({
  query: z.string().trim().max(80).default(""),
  limit: z.coerce.number().int().min(3).max(8).default(5),
  searchLimit: z.coerce.number().int().min(5).max(30).default(20),
  refresh: queryBooleanSchema,
  deferSearchScores: queryBooleanSchema,
  scoreSlug: z.string().trim().max(120).default(""),
});

export const aiSynergyHistoryQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(30),
  limit: z.coerce.number().int().min(1).max(90).default(30),
});

export const morningBriefingQuerySchema = z.object({
  refresh: z.coerce.boolean().default(false),
});

export const careerVibePlanQuerySchema = z.object({
  refresh: z.coerce.boolean().default(false),
});

export const fullNatalAnalysisQuerySchema = z.object({
  refresh: z.coerce.boolean().default(false),
});

function normalizeAstrologyBaseUrl(input: string) {
  const url = new URL(input);
  const normalizedPath = url.pathname.replace(/\/+$/, "");
  if (normalizedPath === "" || normalizedPath === "/") {
    url.pathname = "/v1";
  } else {
    url.pathname = normalizedPath;
  }
  return url.toString().replace(/\/+$/, "");
}

export function resolveAstrologyAuthHeaders(): Record<string, string> | null {
  const apiKey = env.ASTROLOGY_API_KEY?.trim();
  if (!apiKey) return null;

  if (apiKey.startsWith("ak-")) {
    return {
      "x-astrologyapi-key": apiKey,
    };
  }

  const userId = env.ASTROLOGY_USER_ID?.trim();
  if (!userId) return null;
  const auth = Buffer.from(`${userId}:${apiKey}`).toString("base64");
  return {
    Authorization: `Basic ${auth}`,
  };
}

export async function callAstrologyApi<T>(
  path: string,
  body: AstrologyApiBody,
): Promise<{ status: number; data: T | null; text: string }> {
  const authHeaders = resolveAstrologyAuthHeaders();
  if (!authHeaders) {
    throw new Error("Astrology API credentials are not configured");
  }
  const baseUrl = normalizeAstrologyBaseUrl(env.ASTROLOGY_URL);

  const response = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "Accept-Language": "en",
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

export function parseBirthDate(input: string) {
  const [dayRaw, monthRaw, yearRaw] = input.split("/");
  const day = Number(dayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (
    !Number.isInteger(day) ||
    !Number.isInteger(month) ||
    !Number.isInteger(year)
  ) {
    return null;
  }
  if (
    day < 1 ||
    day > 31 ||
    month < 1 ||
    month > 12 ||
    year < 1900 ||
    year > 2100
  ) {
    return null;
  }
  return { day, month, year };
}

export function parseBirthTime(input: string | null, unknownTime: boolean) {
  if (unknownTime || !input) {
    return { hour: 12, min: 0, isApproximate: true };
  }

  const [hourRaw, minRaw] = input.split(":");
  const hour = Number(hourRaw);
  const min = Number(minRaw);
  if (
    !Number.isInteger(hour) ||
    !Number.isInteger(min) ||
    hour < 0 ||
    hour > 23 ||
    min < 0 ||
    min > 59
  ) {
    return null;
  }
  return { hour, min, isApproximate: false };
}

export function toFloat(value: string | number) {
  const numeric = typeof value === "number" ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

export function buildGeoQueryCandidates(cityInput: string) {
  const normalized = cityInput.trim();
  const byComma = normalized
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  const candidates = [
    normalized,
    byComma[0],
    byComma.slice(0, 2).join(" "),
    byComma.join(" "),
  ].filter((value): value is string => !!value && value.length >= 2);
  return [...new Set(candidates)];
}

function normalizeCity(city: string) {
  return city.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeOptionalText(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function normalizePersonName(value: string | null | undefined) {
  if (typeof value !== "string") return "";
  return value.trim().replace(/\s+/g, " ");
}

export function normalizeCoordinate(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Number(value.toFixed(6));
}

function buildProfileHash(input: NatalInput) {
  const latitude = normalizeCoordinate(input.latitude ?? null);
  const longitude = normalizeCoordinate(input.longitude ?? null);
  const normalized = {
    birthDate: input.birthDate.trim(),
    birthTime: input.birthTime ?? null,
    unknownTime: Boolean(input.unknownTime),
    city: normalizeCity(input.city),
    country: normalizeOptionalText(input.country),
    admin1: normalizeOptionalText(input.admin1),
    latitude,
    longitude,
    houseType: HOUSE_TYPE,
    provider: "astrologyapi-v1",
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export async function upsertBirthProfile(userId: ObjectId, input: NatalInput) {
  const collections = await getCollections();
  const now = new Date();
  const profileHash = buildProfileHash(input);
  await collections.birthProfiles.updateOne(
    { userId },
    {
      $set: {
        name: normalizePersonName(input.name),
        birthDate: input.birthDate,
        birthTime: input.birthTime,
        unknownTime: input.unknownTime,
        city: input.city,
        latitude: normalizeCoordinate(input.latitude ?? null),
        longitude: normalizeCoordinate(input.longitude ?? null),
        country: normalizeOptionalText(input.country),
        admin1: normalizeOptionalText(input.admin1),
        normalizedCity: normalizeCity(input.city),
        profileHash,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true },
  );
  return profileHash;
}

function isBodyEmpty(value: unknown) {
  return (
    !value ||
    typeof value !== "object" ||
    Object.keys(value as Record<string, unknown>).length === 0
  );
}

export async function resolveNatalInputForUser(
  userId: ObjectId,
  body: unknown,
) {
  if (!isBodyEmpty(body)) {
    const parsed = natalChartRequestSchema.safeParse(body);
    if (!parsed.success) {
      return {
        ok: false as const,
        code: 400 as const,
        details: parsed.error.flatten().fieldErrors,
      };
    }
    const profileHash = await upsertBirthProfile(userId, parsed.data);
    return { ok: true as const, input: parsed.data, profileHash };
  }

  const collections = await getCollections();
  const stored = await collections.birthProfiles.findOne({ userId });
  if (!stored) {
    return { ok: false as const, code: 404 as const, details: null };
  }

  return {
    ok: true as const,
    input: {
      name: typeof stored.name === "string" ? stored.name : "",
      birthDate: stored.birthDate,
      birthTime: stored.birthTime,
      unknownTime: stored.unknownTime,
      city: stored.city,
      latitude: typeof stored.latitude === "number" ? stored.latitude : null,
      longitude: typeof stored.longitude === "number" ? stored.longitude : null,
      country: stored.country ?? null,
      admin1: stored.admin1 ?? null,
    } satisfies NatalInput,
    profileHash: stored.profileHash,
  };
}

function parseRetro(value: string | boolean | undefined) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return (
    normalized === "true" ||
    normalized === "retrograde" ||
    normalized === "retro" ||
    normalized === "r" ||
    normalized === "rx"
  );
}

export function buildChartPromptPayload(
  chart: WesternChart,
): ChartPromptPayload {
  const placements = chart.houses
    .flatMap((house) =>
      (house.planets ?? []).map((planet) => ({
        planet: planet.name,
        sign: planet.sign,
        house: house.house_id,
        fullDegree: planet.full_degree,
        retrograde: parseRetro(planet.is_retro),
      })),
    )
    .sort((a, b) => a.fullDegree - b.fullDegree);

  const aspects = chart.aspects
    .map((aspect) => ({
      from: aspect.aspecting_planet,
      to: aspect.aspected_planet,
      type: aspect.type,
      orb: typeof aspect.orb === "number" ? aspect.orb : null,
    }))
    .slice(0, 40);

  const ascSign =
    chart.houses.find((house) => house.house_id === 1)?.sign ?? "Unknown";
  const mcSign =
    chart.houses.find((house) => house.house_id === 10)?.sign ?? "Unknown";

  return {
    ascSign,
    mcSign,
    placements,
    aspects,
  };
}

export type FullNatalAnalysisRouteResponse = {
  cached: boolean;
  model: string;
  promptVersion: string;
  narrativeSource: "template" | "llm";
  generatedAt: string;
  analysis: FullNatalCareerAnalysisPayloadDoc;
};

export async function getOrCreateFullNatalAnalysisForUser(input: {
  userId: ObjectId;
  refresh: boolean;
  logger: FastifyBaseLogger;
}): Promise<FullNatalAnalysisRouteResponse> {
  const collections = await getCollections();
  const profile = await collections.birthProfiles.findOne({
    userId: input.userId,
  });
  if (!profile) {
    throw new Error("Birth profile not found");
  }
  const { profileHash } = profile;

  const config = getFullNatalAnalysisConfig();
  if (!input.refresh) {
    const cached = await collections.fullNatalCareerAnalysis.findOne({
      userId: input.userId,
      profileHash,
      promptVersion: config.promptVersion,
      model: config.model,
    });

    if (cached) {
      return {
        cached: true,
        model: cached.model,
        promptVersion: cached.promptVersion,
        narrativeSource: cached.narrativeSource,
        generatedAt: cached.generatedAt.toISOString(),
        analysis: cached.analysis,
      };
    }
  }

  const [natalChart, latestAiSynergy, latestCareerInsight] = await Promise.all([
    collections.natalCharts.findOne(
      {
        userId: input.userId,
        profileHash,
      },
      { projection: { chart: 1 } },
    ),
    collections.aiSynergyDaily.findOne(
      {
        userId: input.userId,
        profileHash,
      },
      { sort: { dateKey: -1, updatedAt: -1 }, projection: { score: 1, band: 1 } },
    ),
    collections.careerInsights.findOne(
      {
        userId: input.userId,
        profileHash,
        tier: "premium",
      },
      { sort: { generatedAt: -1 }, projection: { summary: 1 } },
    ),
  ]);

  if (!natalChart) {
    throw new Error("Natal chart not found. Generate chart first.");
  }

  const parsedChart = westernChartSchema.safeParse(natalChart.chart);
  if (!parsedChart.success) {
    input.logger.error(
      { issues: parsedChart.error.issues },
      "cached natal chart validation failed for full analysis",
    );
    throw new Error("Cached natal chart has invalid format");
  }

  const generated = await generateFullNatalCareerAnalysis({
    chartPayload: buildChartPromptPayload(parsedChart.data),
    context: {
      aiSynergyScore: latestAiSynergy?.score ?? null,
      aiSynergyBand: latestAiSynergy?.band ?? null,
      careerInsightsSummary: latestCareerInsight?.summary ?? null,
    },
  });

  const now = new Date();
  await collections.fullNatalCareerAnalysis.updateOne(
    {
      userId: input.userId,
      profileHash,
      promptVersion: generated.promptVersion,
      model: generated.model,
    },
    {
      $set: {
        analysis: generated.analysis,
        narrativeSource: generated.narrativeSource,
        generatedAt: now,
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
    cached: false,
    model: generated.model,
    promptVersion: generated.promptVersion,
    narrativeSource: generated.narrativeSource,
    generatedAt: now.toISOString(),
    analysis: generated.analysis,
  };
}
