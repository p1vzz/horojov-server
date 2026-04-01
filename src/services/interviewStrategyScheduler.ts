import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { getCollections } from '../db/mongo.js';
import { runWithConcurrency } from './asyncPool.js';
import { maybeRefillInterviewStrategyWindowForUser } from './interviewStrategy.js';
import { runWithSchedulerLock } from './schedulerLockPolicy.js';

function resolveEffectiveSubscriptionTier(input: 'free' | 'premium' | undefined) {
  if (env.DEV_FORCE_PREMIUM_FOR_ALL_USERS) return 'premium' as const;
  return input === 'premium' ? 'premium' : 'free';
}

async function runPlanningPass(logger: FastifyBaseLogger) {
  const collections = await getCollections();
  const settingsDocs = await collections.interviewStrategySettings
    .find({
      enabled: true,
      autoFillConfirmedAt: { $ne: null },
    }, {
      projection: {
        _id: 1,
        userId: 1,
        enabled: 1,
        timezoneIana: 1,
        slotDurationMinutes: 1,
        allowedWeekdays: 1,
        workdayStartMinute: 1,
        workdayEndMinute: 1,
        quietHoursStartMinute: 1,
        quietHoursEndMinute: 1,
        slotsPerWeek: 1,
        autoFillConfirmedAt: 1,
        autoFillStartAt: 1,
        filledUntilDateKey: 1,
        lastGeneratedAt: 1,
        createdAt: 1,
        updatedAt: 1,
      },
    })
    .toArray();

  const userIdMap = new Map(settingsDocs.map((settings) => [settings.userId.toHexString(), settings.userId]));
  const userIds = Array.from(userIdMap.values());
  const users = userIds.length
    ? await collections.users
        .find(
          { _id: { $in: userIds } },
          { projection: { _id: 1, subscriptionTier: 1 } },
        )
        .toArray()
    : [];
  const subscriptionTierByUserId = new Map(
    users.map((user) => [user._id.toHexString(), user.subscriptionTier]),
  );
  const planningConcurrency = Math.max(
    1,
    Math.min(env.INTERVIEW_STRATEGY_SCHEDULER_CONCURRENCY, settingsDocs.length || 1),
  );

  let generated = 0;
  let skipped = 0;
  let failed = 0;
  let notPremium = 0;

  await runWithConcurrency(settingsDocs, planningConcurrency, async (settings) => {
    try {
      const effectiveTier = resolveEffectiveSubscriptionTier(
        subscriptionTierByUserId.get(settings.userId.toHexString()),
      );
      if (effectiveTier !== 'premium') {
        notPremium += 1;
        return;
      }

      const result = await maybeRefillInterviewStrategyWindowForUser({
        userId: settings.userId,
        logger,
        source: 'scheduler_refill',
        settingsDoc: settings,
      });
      if (result.status === 'generated') {
        generated += 1;
        logger.info(
          {
            userId: settings.userId.toHexString(),
            reason: result.reason,
            generation: result.generation
              ? {
                  generated: result.generation.generated,
                  updated: result.generation.updated,
                  skipped: result.generation.skipped,
                  range: result.generation.dateRange,
                }
              : null,
          },
          'interview strategy scheduler generated/refilled plan'
        );
      } else {
        skipped += 1;
      }
    } catch (error) {
      failed += 1;
      logger.error(
        {
          error,
          userId: settings.userId.toHexString(),
        },
        'interview strategy scheduler failed for user'
      );
    }
  });

  logger.info(
    {
      candidates: settingsDocs.length,
      generated,
      skipped,
      notPremium,
      failed,
      planningConcurrency,
      thresholdDays: env.INTERVIEW_STRATEGY_REFILL_THRESHOLD_DAYS,
      refillDays: env.INTERVIEW_STRATEGY_REFILL_DAYS,
    },
    'interview strategy scheduler cycle finished'
  );
}

export function startInterviewStrategyScheduler(logger: FastifyBaseLogger) {
  if (!env.INTERVIEW_STRATEGY_AUTOFILL_ENABLED) {
    logger.info('interview strategy scheduler is disabled by config');
    return () => undefined;
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const intervalMs = env.INTERVIEW_STRATEGY_CHECK_INTERVAL_SECONDS * 1000;

  const runCycle = async () => {
    const bucket = Math.floor(Date.now() / intervalMs);
    await runWithSchedulerLock({
      scheduler: 'interview_strategy',
      scope: String(bucket),
      logger,
      meta: {
        bucket,
      },
      run: async () => {
        try {
          await runPlanningPass(logger);
        } catch (error) {
          logger.error({ error }, 'interview strategy scheduler cycle failed');
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
      intervalSeconds: env.INTERVIEW_STRATEGY_CHECK_INTERVAL_SECONDS,
      thresholdDays: env.INTERVIEW_STRATEGY_REFILL_THRESHOLD_DAYS,
      refillDays: env.INTERVIEW_STRATEGY_REFILL_DAYS,
      initialHorizonDays: env.INTERVIEW_STRATEGY_INITIAL_HORIZON_DAYS,
      planningConcurrency: env.INTERVIEW_STRATEGY_SCHEDULER_CONCURRENCY,
    },
    'interview strategy scheduler started'
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
