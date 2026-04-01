import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config/env.js';
import { collectJobMetrics, evaluateJobMetricsAlerts } from './jobMetrics.js';
import { runWithSchedulerLock } from './schedulerLockPolicy.js';

export function startJobMetricsAlertScheduler(logger: FastifyBaseLogger) {
  if (!env.JOB_METRICS_ALERTS_ENABLED) {
    logger.info('job metrics alert scheduler is disabled by config');
    return () => undefined;
  }

  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const intervalMs = env.JOB_METRICS_ALERT_CHECK_INTERVAL_SECONDS * 1000;
  const runCheckWithoutLock = async () => {
    try {
      const metrics = await collectJobMetrics(env.JOB_METRICS_ALERT_WINDOW_HOURS);
      const alerts = evaluateJobMetricsAlerts(metrics);

      if (!alerts.hasAlerts) {
        logger.info(
          {
            window: alerts.window,
            checkedSources: metrics.sources.length,
          },
          'job metrics check finished without alerts'
        );
        return;
      }

      logger.warn(
        {
          window: alerts.window,
          thresholds: alerts.thresholds,
          alerts: alerts.alerts,
        },
        'job metrics alerts triggered'
      );
    } catch (error) {
      logger.error({ error }, 'job metrics alert scheduler check failed');
    }
  };

  const runCheck = async () => {
    const bucket = Math.floor(Date.now() / intervalMs);
    const scope = `${env.JOB_METRICS_ALERT_WINDOW_HOURS}:${bucket}`;
    await runWithSchedulerLock({
      scheduler: 'job_metrics',
      scope,
      logger,
      meta: {
        bucket,
        windowHours: env.JOB_METRICS_ALERT_WINDOW_HOURS,
      },
      run: runCheckWithoutLock,
      onLockedSkip: () => undefined,
    });
  };

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(async () => {
      await runCheck();
      scheduleNext();
    }, intervalMs);
  };

  logger.info(
    {
      intervalSeconds: env.JOB_METRICS_ALERT_CHECK_INTERVAL_SECONDS,
      windowHours: env.JOB_METRICS_ALERT_WINDOW_HOURS,
    },
    'job metrics alert scheduler started'
  );

  void (async () => {
    await runCheck();
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
