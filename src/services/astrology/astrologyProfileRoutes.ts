import type { FastifyInstance } from 'fastify';
import { env } from '../../config/env.js';
import { getCollections } from '../../db/mongo.js';
import { listAiSynergyHistory } from '../aiSynergy.js';
import {
  buildTodayDate,
  getOrCreateDailyTransitForUser,
  toDailyTransitResponse,
} from '../dailyTransit.js';
import {
  aiSynergyHistoryQuerySchema,
  buildBirthProfileEditLockSnapshot,
  buildProfileHash,
  careerVibePlanQuerySchema,
  dailyTransitQuerySchema,
  natalChartRequestSchema,
  normalizeCurrentJobTitle,
  resolveBirthProfileEditPolicy,
  serializeBirthProfileEditLock,
  upsertBirthProfile,
} from './astrologyShared.js';
import { requireAstrologyAuth } from './astrologyRouteGuards.js';
import type { AstrologyRouteDependencies } from './astrologyRouteTypes.js';
import { getOrCreateCareerVibePlanForUser } from '../careerVibePlan.js';
import { resetInterviewStrategyWindowAfterProfileChange } from '../interviewStrategy.js';
import { getDiscoverRoleCurrentJob } from './discoverRoleCurrentJobStore.js';

function hasBirthProfileFieldChanges(
  existingProfile: {
    name?: string | null;
    birthDate?: string | null;
    birthTime?: string | null;
    unknownTime?: boolean | null;
    city?: string | null;
    latitude?: number | null;
    longitude?: number | null;
    country?: string | null;
    admin1?: string | null;
  } | null,
  nextProfile: {
    name?: string;
    birthDate: string;
    birthTime: string | null;
    unknownTime: boolean;
    city: string;
    latitude?: number | null;
    longitude?: number | null;
    country?: string | null;
    admin1?: string | null;
  },
) {
  if (!existingProfile) return true;

  return (
    (typeof existingProfile.name === "string" ? existingProfile.name.trim() : "") !==
      (typeof nextProfile.name === "string" ? nextProfile.name.trim() : "") ||
    existingProfile.birthDate !== nextProfile.birthDate ||
    (existingProfile.birthTime ?? null) !== nextProfile.birthTime ||
    Boolean(existingProfile.unknownTime) !== nextProfile.unknownTime ||
    (typeof existingProfile.city === "string" ? existingProfile.city.trim() : "") !== nextProfile.city.trim() ||
    (typeof existingProfile.latitude === "number" ? existingProfile.latitude : null) !== (nextProfile.latitude ?? null) ||
    (typeof existingProfile.longitude === "number" ? existingProfile.longitude : null) !== (nextProfile.longitude ?? null) ||
    (typeof existingProfile.country === "string" ? existingProfile.country.trim() : null) !== (nextProfile.country ?? null) ||
    (typeof existingProfile.admin1 === "string" ? existingProfile.admin1.trim() : null) !== (nextProfile.admin1 ?? null)
  );
}

export function registerAstrologyProfileRoutes(
  app: FastifyInstance,
  deps: AstrologyRouteDependencies,
) {
  app.get("/birth-profile", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const collections = await getCollections();
    const profile = await collections.birthProfiles.findOne({
      userId: auth.user._id,
    });
    if (!profile) {
      return reply.code(404).send({ error: "Birth profile is not set" });
    }

    const currentJob =
      typeof profile.currentJobTitle === "string" && profile.currentJobTitle.trim().length > 0
        ? null
        : await getDiscoverRoleCurrentJob({
            userId: auth.user._id,
          });

    return {
      profile: {
        name: typeof profile.name === "string" ? profile.name : "",
        birthDate: profile.birthDate,
        birthTime: profile.birthTime,
        unknownTime: profile.unknownTime,
        city: profile.city,
        currentJobTitle: normalizeCurrentJobTitle(profile.currentJobTitle) ?? currentJob?.title ?? null,
        latitude:
          typeof profile.latitude === "number" ? profile.latitude : null,
        longitude:
          typeof profile.longitude === "number" ? profile.longitude : null,
        country: profile.country ?? null,
        admin1: profile.admin1 ?? null,
        updatedAt: profile.updatedAt.toISOString(),
      },
      editLock: serializeBirthProfileEditLock(
        env.BIRTH_PROFILE_EDIT_LOCKS_ENABLED
          ? buildBirthProfileEditLockSnapshot(profile)
          : buildBirthProfileEditLockSnapshot(null),
      ),
    };
  });

  app.put("/birth-profile", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsed = natalChartRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid request payload",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const collections = await getCollections();
    const existingProfile = await collections.birthProfiles.findOne(
      { userId: auth.user._id },
      {
        projection: {
          name: 1,
          profileHash: 1,
          birthDate: 1,
          birthTime: 1,
          unknownTime: 1,
          city: 1,
          latitude: 1,
          longitude: 1,
          country: 1,
          admin1: 1,
          currentJobTitle: 1,
          birthEditLockDurationDays: 1,
          birthEditLockedUntil: 1,
          birthEditLockLevel: 1,
        },
      },
    );
    const currentJobFieldProvided = "currentJobTitle" in parsed.data;
    const nextCurrentJobTitle = normalizeCurrentJobTitle(parsed.data.currentJobTitle);
    const existingCurrentJobTitle = normalizeCurrentJobTitle(existingProfile?.currentJobTitle);
    const currentJobChanged = currentJobFieldProvided && nextCurrentJobTitle !== existingCurrentJobTitle;
    const birthProfileFieldChanges = hasBirthProfileFieldChanges(existingProfile, parsed.data);
    const nextProfileHash = buildProfileHash(parsed.data);
    const editPolicy = env.BIRTH_PROFILE_EDIT_LOCKS_ENABLED
      ? resolveBirthProfileEditPolicy(existingProfile, nextProfileHash)
      : null;
    if (editPolicy?.blocked) {
      const editLock = serializeBirthProfileEditLock(editPolicy.lock);
      return reply.code(429).send({
        error: "Birth profile edit is temporarily locked.",
        code: "birth_profile_edit_locked",
        editLock,
        lockedUntil: editLock.lockedUntil,
        retryAfterSeconds: editLock.retryAfterSeconds,
        lockLevel: editLock.lockLevel,
      });
    }

    const profileHash = await upsertBirthProfile(auth.user._id, parsed.data, {
      editLock: editPolicy?.nextLock ?? null,
      currentJobChanged,
      touchUpdatedAt: birthProfileFieldChanges,
    });
    if (existingProfile?.profileHash && existingProfile.profileHash !== profileHash) {
      await resetInterviewStrategyWindowAfterProfileChange({
        userId: auth.user._id,
      });
    }

    return {
      profile: {
        name: parsed.data.name ?? "",
        birthDate: parsed.data.birthDate,
        birthTime: parsed.data.birthTime,
        unknownTime: parsed.data.unknownTime,
        city: parsed.data.city,
        latitude: parsed.data.latitude ?? null,
        longitude: parsed.data.longitude ?? null,
        country: parsed.data.country ?? null,
        admin1: parsed.data.admin1 ?? null,
        currentJobTitle: currentJobFieldProvided ? nextCurrentJobTitle : existingCurrentJobTitle,
      },
      editLock: serializeBirthProfileEditLock(
        editPolicy?.nextLock
          ? buildBirthProfileEditLockSnapshot(
              {
                birthEditLockDurationDays: editPolicy.nextLock.durationDays,
                birthEditLockedUntil: editPolicy.nextLock.lockedUntil,
                birthEditLockLevel: editPolicy.nextLock.lockLevel,
              },
            )
          : editPolicy?.lock ?? buildBirthProfileEditLockSnapshot(null),
      ),
    };
  });

  app.get("/daily-transit", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedQuery = dailyTransitQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parsedQuery.error.flatten().fieldErrors,
      });
    }

    try {
      const result = await getOrCreateDailyTransitForUser(
        auth.user._id,
        buildTodayDate(),
        request.log,
        {
          aiSynergyMode: parsedQuery.data.includeAiSynergy ? "sync" : "cache-only",
        },
      );
      return toDailyTransitResponse(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Birth profile not found")) {
        return reply.code(404).send({
          error: "Birth profile not found. Complete onboarding first.",
        });
      }
      request.log.error({ error }, "daily transit request failed");
      return reply.code(502).send({ error: "Unable to build daily transit" });
    }
  });

  app.get("/career-vibe-plan", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsedQuery = careerVibePlanQuerySchema.safeParse(request.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parsedQuery.error.flatten().fieldErrors,
      });
    }

    try {
      const result = await getOrCreateCareerVibePlanForUser({
        userId: auth.user._id,
        date: buildTodayDate(),
        tier: auth.user.subscriptionTier === "premium" ? "premium" : "free",
        logger: request.log,
        refresh: parsedQuery.data.refresh,
        llmMode: parsedQuery.data.refresh ? "sync" : "background",
      });
      return result.item;
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message.includes("Birth profile not found")) {
        return reply.code(404).send({
          error: "Birth profile not found. Complete onboarding first.",
        });
      }
      request.log.error({ error }, "career vibe plan request failed");
      return reply.code(502).send({ error: "Unable to build career vibe plan" });
    }
  });

  app.get("/ai-synergy/history", async (request, reply) => {
    const auth = await requireAstrologyAuth(request, reply, deps);
    if (!auth) return;

    const parsed = aiSynergyHistoryQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({
        error: "Invalid query parameters",
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const history = await listAiSynergyHistory({
      userId: auth.user._id,
      days: parsed.data.days,
      limit: parsed.data.limit,
    });

    return {
      days: parsed.data.days,
      count: history.length,
      items: history,
    };
  });
}
