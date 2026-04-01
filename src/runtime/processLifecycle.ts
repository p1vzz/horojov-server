import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { closeMongoConnection, ensureMongoIndexes } from '../db/mongo.js';
import { closeBrowserFallback } from '../services/browserFallback.js';
import { closeCacheStoreConnection } from '../services/cacheStore.js';
import { startBurnoutAlertScheduler } from '../services/burnoutAlertScheduler.js';
import { startDailyTransitScheduler } from '../services/dailyTransitScheduler.js';
import { startInterviewStrategyScheduler } from '../services/interviewStrategyScheduler.js';
import { startJobMetricsAlertScheduler } from '../services/jobMetricsAlertScheduler.js';
import { getWorkerSchedulerRuntimeIssues } from './runtimeProcessCore.js';

type StopFn = () => void;

export async function ensureRuntimeDataReady() {
  await ensureMongoIndexes();
}

export function assertWorkerRuntimeConfig() {
  const issues = getWorkerSchedulerRuntimeIssues({
    nodeEnv: env.NODE_ENV,
    redisEnabled: env.REDIS_ENABLED,
    redisUrl: env.REDIS_URL ?? '',
    schedulerLocksEnabled: env.SCHEDULER_LOCKS_ENABLED,
  });

  if (issues.length > 0) {
    throw new Error(`Invalid worker runtime configuration: ${issues.join('; ')}`);
  }
}

export function startAllSchedulers(app: FastifyInstance) {
  const stoppers: StopFn[] = [
    startDailyTransitScheduler(app.log),
    startJobMetricsAlertScheduler(app.log),
    startBurnoutAlertScheduler(app.log),
    startInterviewStrategyScheduler(app.log),
  ];

  return () => {
    while (stoppers.length > 0) {
      const stop = stoppers.pop();
      if (stop) {
        stop();
      }
    }
  };
}

export function registerTerminationSignals(shutdown: () => Promise<void>) {
  const handleSignal = () => {
    void shutdown();
  };

  process.on('SIGINT', handleSignal);
  process.on('SIGTERM', handleSignal);

  return () => {
    process.off('SIGINT', handleSignal);
    process.off('SIGTERM', handleSignal);
  };
}

export async function closeProcessResources(input: {
  app: FastifyInstance;
  stopSchedulers?: StopFn | null;
}) {
  input.stopSchedulers?.();
  await input.app.close();
  await closeBrowserFallback();
  await closeCacheStoreConnection();
  await closeMongoConnection();
}

export function createProcessShutdown(input: {
  app: FastifyInstance;
  stopSchedulers?: StopFn | null;
}) {
  let shuttingDown = false;

  return async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    input.app.log.info('Shutting down');

    try {
      await closeProcessResources(input);
      process.exit(0);
    } catch (error) {
      input.app.log.error(error, 'Shutdown failed');
      await closeBrowserFallback();
      await closeCacheStoreConnection();
      await closeMongoConnection();
      process.exit(1);
    }
  };
}
