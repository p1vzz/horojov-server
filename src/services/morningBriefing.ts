import { ObjectId } from 'mongodb';
import type { FastifyBaseLogger } from 'fastify';
import {
  getCollections,
  type MorningBriefingDailyDoc,
  type MongoCollections,
  type AlgorithmTagDoc,
  type AiSynergyConfidenceBreakdownDoc,
} from '../db/mongo.js';
import { getOrCreateDailyTransitForUser } from './dailyTransit.js';
import { buildCareerVibePlanView, toMorningBriefingPlanSnapshot } from './careerVibePlan.js';

const MORNING_BRIEFING_SCHEMA_VERSION = 'morning-briefing-v2';

export type MorningBriefingView = {
  dateKey: string;
  cached: boolean;
  generatedAt: string;
  schemaVersion: string;
  headline: string;
  summary: string;
  metrics: {
    energy: number;
    focus: number;
    luck: number;
    aiSynergy: number;
  };
  modeLabel: string;
  plan?: {
    headline: string;
    summary: string;
    primaryAction: string;
    peakWindow: string;
    riskGuardrail: string;
  };
  insights?: {
    vibe: {
      algorithmVersion: string;
      drivers: string[];
      cautions: string[];
      tags: AlgorithmTagDoc[];
    };
    aiSynergy?: {
      algorithmVersion: string;
      band: 'peak' | 'strong' | 'stable' | 'volatile';
      confidence: number;
      confidenceBreakdown: AiSynergyConfidenceBreakdownDoc;
      drivers: string[];
      cautions: string[];
      actionsPriority: string[];
      tags: AlgorithmTagDoc[];
      narrativeVariantId: string;
      styleProfile: string;
    };
  };
  staleAfter: string;
  sources: {
    dailyTransitDateKey: string;
    aiSynergyDateKey: string | null;
  };
};

export type EnsureMorningBriefingResult = {
  item: MorningBriefingView;
  cached: boolean;
};

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function clampScore(value: number) {
  return Math.max(10, Math.min(99, Math.round(value)));
}

function deriveBaselineAiSynergyScore(metrics: { energy: number; focus: number; luck: number }) {
  const weighted = metrics.energy * 0.34 + metrics.focus * 0.44 + metrics.luck * 0.22;
  const coherenceBoost = (metrics.focus - metrics.energy) * 0.06;
  return clampScore(weighted + coherenceBoost);
}

function buildStaleAfter(dateKey: string, referenceBase: Date) {
  const midnightUtc = new Date(`${dateKey}T00:00:00.000Z`);
  if (Number.isNaN(midnightUtc.getTime())) {
    return new Date(referenceBase.getTime() + 24 * 60 * 60 * 1000);
  }
  midnightUtc.setUTCDate(midnightUtc.getUTCDate() + 1);
  return midnightUtc;
}

function toMorningBriefingView(doc: MorningBriefingDailyDoc, cached: boolean): MorningBriefingView {
  return {
    dateKey: doc.dateKey,
    cached,
    generatedAt: doc.generatedAt.toISOString(),
    schemaVersion: doc.schemaVersion,
    headline: doc.headline,
    summary: doc.summary,
    metrics: {
      energy: doc.metrics.energy,
      focus: doc.metrics.focus,
      luck: doc.metrics.luck,
      aiSynergy: doc.metrics.aiSynergy,
    },
    modeLabel: doc.modeLabel,
    plan: doc.plan,
    insights: doc.insights,
    staleAfter: doc.staleAfter.toISOString(),
    sources: {
      dailyTransitDateKey: doc.sources.dailyTransitDateKey,
      aiSynergyDateKey: doc.sources.aiSynergyDateKey,
    },
  };
}

export async function getOrCreateMorningBriefingForUser(input: {
  userId: ObjectId;
  date: Date;
  logger: FastifyBaseLogger;
  refresh?: boolean;
  collections?: MongoCollections;
}): Promise<EnsureMorningBriefingResult> {
  const collections = input.collections ?? (await getCollections());
  const profile = await collections.birthProfiles.findOne({ userId: input.userId });
  if (!profile) {
    throw new Error('Birth profile not found');
  }

  const dateKey = toDateKey(input.date);
  const filter = {
    userId: input.userId,
    profileHash: profile.profileHash,
    dateKey,
    schemaVersion: MORNING_BRIEFING_SCHEMA_VERSION,
  };

  if (!input.refresh) {
    const existing = await collections.morningBriefingDaily.findOne(filter);
    if (existing) {
      return {
        item: toMorningBriefingView(existing, true),
        cached: true,
      };
    }
  }

  const transit = await getOrCreateDailyTransitForUser(input.userId, input.date, input.logger, {
    aiSynergyMode: 'cache-only',
  });
  const now = new Date();

  const energy = clampScore(transit.doc.vibe.metrics.energy);
  const focus = clampScore(transit.doc.vibe.metrics.focus);
  const luck = clampScore(transit.doc.vibe.metrics.luck);
  const readyAiSynergy = transit.aiSynergy?.narrativeStatus === 'ready' ? transit.aiSynergy : null;
  const aiSynergy = transit.aiSynergy?.score ?? deriveBaselineAiSynergyScore({ energy, focus, luck });
  const vibeDrivers = transit.doc.vibe.drivers ?? [];
  const vibeCautions = transit.doc.vibe.cautions ?? [];
  const vibeTags = transit.doc.vibe.tags ?? [];
  const staleAfter = buildStaleAfter(dateKey, now);
  const planSnapshot = toMorningBriefingPlanSnapshot(
    buildCareerVibePlanView({
      dateKey,
      cached: false,
      tier: 'premium',
      generatedAt: now,
      staleAfter,
      transitVibe: transit.doc.vibe,
      aiSynergy: transit.aiSynergy,
      narrativeStatus: 'unavailable',
      narrativeFailureCode: 'llm_unavailable',
      sources: {
        dailyTransitDateKey: transit.doc.dateKey,
        aiSynergyDateKey: transit.aiSynergy?.dateKey ?? null,
        dailyVibeAlgorithmVersion: transit.doc.vibe.algorithmVersion,
        aiSynergyAlgorithmVersion: transit.aiSynergy?.algorithmVersion ?? null,
      },
    })
  );

  const generatedDoc: MorningBriefingDailyDoc = {
    _id: new ObjectId(),
    userId: input.userId,
    profileHash: profile.profileHash,
    dateKey,
    schemaVersion: MORNING_BRIEFING_SCHEMA_VERSION,
    headline: readyAiSynergy?.headline?.trim() || transit.doc.vibe.title,
    summary: readyAiSynergy?.summary?.trim() || transit.doc.vibe.summary,
    modeLabel: transit.doc.vibe.modeLabel,
    metrics: {
      energy,
      focus,
      luck,
      aiSynergy: clampScore(aiSynergy),
    },
    plan: planSnapshot ?? undefined,
    insights: {
      vibe: {
        algorithmVersion: transit.doc.vibe.algorithmVersion,
        drivers: vibeDrivers,
        cautions: vibeCautions,
        tags: vibeTags,
      },
      aiSynergy: transit.aiSynergy
        ? {
            algorithmVersion: transit.aiSynergy.algorithmVersion,
            band: transit.aiSynergy.band,
            confidence: transit.aiSynergy.confidence,
            confidenceBreakdown: transit.aiSynergy.confidenceBreakdown,
            drivers: transit.aiSynergy.drivers,
            cautions: transit.aiSynergy.cautions,
            actionsPriority: transit.aiSynergy.actionsPriority,
            tags: transit.aiSynergy.tags,
            narrativeVariantId: transit.aiSynergy.narrativeVariantId,
            styleProfile: transit.aiSynergy.styleProfile,
          }
        : undefined,
    },
    sources: {
      dailyTransitDateKey: transit.doc.dateKey,
      aiSynergyDateKey: transit.aiSynergy?.dateKey ?? null,
    },
    generatedAt: now,
    staleAfter,
    createdAt: now,
    updatedAt: now,
  };

  const persisted = await collections.morningBriefingDaily.findOneAndUpdate(
    filter,
    {
      $set: {
        headline: generatedDoc.headline,
        summary: generatedDoc.summary,
        modeLabel: generatedDoc.modeLabel,
        metrics: generatedDoc.metrics,
        plan: generatedDoc.plan,
        insights: generatedDoc.insights,
        sources: generatedDoc.sources,
        generatedAt: generatedDoc.generatedAt,
        staleAfter: generatedDoc.staleAfter,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: generatedDoc._id,
        createdAt: now,
      },
    },
    { upsert: true, returnDocument: 'after' }
  );

  if (!persisted) {
    return {
      item: toMorningBriefingView(generatedDoc, false),
      cached: false,
    };
  }

  return {
    item: toMorningBriefingView(persisted, false),
    cached: false,
  };
}
