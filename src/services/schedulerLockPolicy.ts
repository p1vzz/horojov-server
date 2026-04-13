import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { shouldAllowUnlockedSchedulers } from '../runtime/runtimeProcessCore.js';
import { releaseLock, tryAcquireLock } from './cacheStore.js';

export type SchedulerLockName =
  | 'daily_transit'
  | 'job_metrics'
  | 'burnout_alerts'
  | 'lunar_productivity'
  | 'interview_strategy';

const SCHEDULER_LOCK_PREFIX: Record<SchedulerLockName, string> = {
  daily_transit: 'lock:daily-transit',
  job_metrics: 'lock:job-metrics',
  burnout_alerts: 'lock:burnout-alerts',
  lunar_productivity: 'lock:lunar-productivity',
  interview_strategy: 'lock:interview-strategy',
};

function resolveSchedulerLockTtlMs(scheduler: SchedulerLockName) {
  switch (scheduler) {
    case 'daily_transit':
      return env.SCHEDULER_LOCK_DAILY_TRANSIT_TTL_SECONDS * 1000;
    case 'job_metrics':
      return env.SCHEDULER_LOCK_JOB_METRICS_TTL_SECONDS * 1000;
    case 'burnout_alerts':
      return env.SCHEDULER_LOCK_BURNOUT_ALERTS_TTL_SECONDS * 1000;
    case 'lunar_productivity':
      return env.SCHEDULER_LOCK_LUNAR_PRODUCTIVITY_TTL_SECONDS * 1000;
    case 'interview_strategy':
      return env.SCHEDULER_LOCK_INTERVIEW_STRATEGY_TTL_SECONDS * 1000;
  }
}

function resolveSchedulerLockKey(scheduler: SchedulerLockName, scope: string) {
  return `${SCHEDULER_LOCK_PREFIX[scheduler]}:${scope}`;
}

export async function runWithSchedulerLock<T>(input: {
  scheduler: SchedulerLockName;
  scope: string;
  logger: FastifyBaseLogger;
  run: () => Promise<T>;
  onLockedSkip?: () => Promise<T | null> | T | null;
  meta?: Record<string, unknown>;
}): Promise<T | null> {
  if (!env.SCHEDULER_LOCKS_ENABLED) {
    if (
      shouldAllowUnlockedSchedulers({
        nodeEnv: env.NODE_ENV,
        redisEnabled: env.REDIS_ENABLED,
        redisUrl: env.REDIS_URL ?? '',
        schedulerLocksEnabled: env.SCHEDULER_LOCKS_ENABLED,
      })
    ) {
      return input.run();
    }

    input.logger.error(
      {
        scheduler: input.scheduler,
        lockScope: input.scope,
        nodeEnv: env.NODE_ENV,
      },
      'scheduler locks are disabled in production, skipping cycle'
    );
    return input.onLockedSkip ? await input.onLockedSkip() : null;
  }

  const ttlMs = resolveSchedulerLockTtlMs(input.scheduler);
  const lockKey = resolveSchedulerLockKey(input.scheduler, input.scope);
  const lockMeta = input.meta ?? {};
  const lock = await tryAcquireLock(lockKey, ttlMs);

  if (!lock.acquired) {
    const lockContext = {
      lock_event: lock.reason === 'backend_unavailable' ? 'lock_backend_unavailable' : 'lock_skipped',
      scheduler: input.scheduler,
      lockBackend: lock.backend,
      lockKey,
      lockScope: input.scope,
      ttlMs,
      ...lockMeta,
    };

    if (lock.reason === 'backend_unavailable') {
      input.logger.error(lockContext, 'scheduler lock backend unavailable, skipping cycle');
    } else {
      input.logger.info(lockContext, 'scheduler lock is busy, skipping cycle');
    }
    return input.onLockedSkip ? await input.onLockedSkip() : null;
  }

  input.logger.info(
    {
      lock_event: 'lock_acquired',
      scheduler: input.scheduler,
      lockBackend: lock.backend,
      lockKey,
      lockScope: input.scope,
      ttlMs,
      ...lockMeta,
    },
    'scheduler lock acquired'
  );

  try {
    return await input.run();
  } finally {
    await releaseLock(lockKey, lock.token);
  }
}
