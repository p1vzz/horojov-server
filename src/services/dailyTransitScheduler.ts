import type { FastifyBaseLogger } from 'fastify';
import { buildTodayDate, generateDailyTransitsForAllUsers } from './dailyTransit.js';
import { runWithSchedulerLock } from './schedulerLockPolicy.js';

function msUntilNextMidnight(now = new Date()) {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime() - now.getTime();
}

function toDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

async function runDailyTransitGeneration(
  logger: FastifyBaseLogger,
  reason: 'startup' | 'midnight'
) {
  const runDate = buildTodayDate();
  const dateKey = toDateKey(runDate);
  return runWithSchedulerLock({
    scheduler: 'daily_transit',
    scope: dateKey,
    logger,
    meta: {
      dateKey,
      reason,
    },
    run: () => generateDailyTransitsForAllUsers(runDate, logger),
  });
}

export function startDailyTransitScheduler(logger: FastifyBaseLogger) {
  let timeout: NodeJS.Timeout | null = null;
  let stopped = false;

  const scheduleNext = () => {
    if (stopped) return;
    const delay = msUntilNextMidnight();
    logger.info({ delayMs: delay }, 'daily transit scheduler armed for next midnight');
    timeout = setTimeout(async () => {
      try {
        const result = await runDailyTransitGeneration(logger, 'midnight');
        if (result) {
          logger.info(result, 'daily transit midnight generation finished');
        }
      } catch (error) {
        logger.error({ error }, 'daily transit midnight generation failed');
      } finally {
        scheduleNext();
      }
    }, delay);
  };

  void (async () => {
    try {
      const result = await runDailyTransitGeneration(logger, 'startup');
      if (result) {
        logger.info(result, 'daily transit startup warmup finished');
      }
    } catch (error) {
      logger.error({ error }, 'daily transit startup warmup failed');
    } finally {
      scheduleNext();
    }
  })();

  return () => {
    stopped = true;
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
  };
}
