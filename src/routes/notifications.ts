import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticateByAuthorizationHeader } from '../services/auth.js';
import { buildTodayDate, getOrCreateDailyTransitForUser } from '../services/dailyTransit.js';
import {
  BURNOUT_TIMING_ALGORITHM_VERSION,
  calculateBurnoutRisk,
  getBurnoutAlertSettingsForUser,
  getLatestBurnoutAlertJobForUser,
  isBurnoutAlertJobCurrentForTransit,
  isValidIanaTimezone,
  markBurnoutAlertJobSeenForUser,
  resolveBurnoutPushSeverity,
  upsertBurnoutAlertSettingsForUser,
  upsertPushNotificationTokenForUser,
} from '../services/burnoutAlerts.js';
import {
  calculateLunarProductivityRisk,
  getLatestLunarProductivityJobForUser,
  getLunarProductivitySettingsForUser,
  isLunarProductivityJobCurrentForTransit,
  LUNAR_PRODUCTIVITY_TIMING_ALGORITHM_VERSION,
  markLunarProductivityJobSeenForUser,
  resolveLunarProductivityImpactDirection,
  resolveLunarProductivityPushSeverity,
  upsertLunarProductivitySettingsForUser,
} from '../services/lunarProductivity.js';
import {
  fetchInterviewStrategyPlanForUser,
  maybeRefillInterviewStrategyWindowForUser,
  rebuildInterviewStrategyWindowForUser,
  upsertInterviewStrategySettingsForUser,
} from '../services/interviewStrategy.js';

export type NotificationRouteDependencies = {
  authenticateByAuthorizationHeader: typeof authenticateByAuthorizationHeader;
  buildTodayDate: typeof buildTodayDate;
  getOrCreateDailyTransitForUser: typeof getOrCreateDailyTransitForUser;
  calculateBurnoutRisk: typeof calculateBurnoutRisk;
  getBurnoutAlertSettingsForUser: typeof getBurnoutAlertSettingsForUser;
  getLatestBurnoutAlertJobForUser: typeof getLatestBurnoutAlertJobForUser;
  isValidIanaTimezone: typeof isValidIanaTimezone;
  markBurnoutAlertJobSeenForUser: typeof markBurnoutAlertJobSeenForUser;
  resolveBurnoutPushSeverity: typeof resolveBurnoutPushSeverity;
  upsertBurnoutAlertSettingsForUser: typeof upsertBurnoutAlertSettingsForUser;
  upsertPushNotificationTokenForUser: typeof upsertPushNotificationTokenForUser;
  calculateLunarProductivityRisk: typeof calculateLunarProductivityRisk;
  getLatestLunarProductivityJobForUser: typeof getLatestLunarProductivityJobForUser;
  getLunarProductivitySettingsForUser: typeof getLunarProductivitySettingsForUser;
  markLunarProductivityJobSeenForUser: typeof markLunarProductivityJobSeenForUser;
  resolveLunarProductivityImpactDirection: typeof resolveLunarProductivityImpactDirection;
  resolveLunarProductivityPushSeverity: typeof resolveLunarProductivityPushSeverity;
  upsertLunarProductivitySettingsForUser: typeof upsertLunarProductivitySettingsForUser;
  fetchInterviewStrategyPlanForUser: typeof fetchInterviewStrategyPlanForUser;
  maybeRefillInterviewStrategyWindowForUser: typeof maybeRefillInterviewStrategyWindowForUser;
  rebuildInterviewStrategyWindowForUser: typeof rebuildInterviewStrategyWindowForUser;
  upsertInterviewStrategySettingsForUser: typeof upsertInterviewStrategySettingsForUser;
};

export type RegisterNotificationRoutesOptions = {
  deps?: Partial<NotificationRouteDependencies>;
};

const pushTokenSchema = z.object({
  token: z.string().trim().min(16).max(512),
  platform: z.enum(['ios', 'android', 'web']),
  appVersion: z.string().trim().min(1).max(64).optional().nullable(),
});

const burnoutSettingsSchema = z.object({
  enabled: z.boolean(),
  timezoneIana: z.string().trim().min(3).max(80),
  workdayStartMinute: z.coerce.number().int().min(0).max(1439),
  workdayEndMinute: z.coerce.number().int().min(0).max(1439),
  quietHoursStartMinute: z.coerce.number().int().min(0).max(1439),
  quietHoursEndMinute: z.coerce.number().int().min(0).max(1439),
});

const burnoutSeenSchema = z.object({
  dateKey: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const lunarProductivitySettingsSchema = z.object({
  enabled: z.boolean(),
  timezoneIana: z.string().trim().min(3).max(80),
  workdayStartMinute: z.coerce.number().int().min(0).max(1439),
  workdayEndMinute: z.coerce.number().int().min(0).max(1439),
  quietHoursStartMinute: z.coerce.number().int().min(0).max(1439),
  quietHoursEndMinute: z.coerce.number().int().min(0).max(1439),
});

const interviewStrategySettingsSchema = z.object({
  enabled: z.boolean(),
  timezoneIana: z.string().trim().min(3).max(80),
  slotDurationMinutes: z.coerce.number().int().refine((value) => value === 30 || value === 45 || value === 60, {
    message: 'slotDurationMinutes must be one of: 30, 45, 60',
  }).default(60),
  allowedWeekdays: z.array(z.coerce.number().int().min(0).max(6)).min(1).max(7).default([1, 2, 3, 4, 5]),
  workdayStartMinute: z.coerce.number().int().min(0).max(1439).default(540),
  workdayEndMinute: z.coerce.number().int().min(0).max(1439).default(1080),
  quietHoursStartMinute: z.coerce.number().int().min(0).max(1439).default(1290),
  quietHoursEndMinute: z.coerce.number().int().min(0).max(1439).default(480),
  slotsPerWeek: z.coerce.number().int().min(1).max(10).default(5),
});

const interviewStrategyPlanQuerySchema = z.object({
  refresh: z.enum(['true', 'false']).optional(),
});

const lunarProductivitySeenSchema = z.object({
  dateKey: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const defaultDeps: NotificationRouteDependencies = {
  authenticateByAuthorizationHeader,
  buildTodayDate,
  getOrCreateDailyTransitForUser,
  calculateBurnoutRisk,
  getBurnoutAlertSettingsForUser,
  getLatestBurnoutAlertJobForUser,
  isValidIanaTimezone,
  markBurnoutAlertJobSeenForUser,
  resolveBurnoutPushSeverity,
  upsertBurnoutAlertSettingsForUser,
  upsertPushNotificationTokenForUser,
  calculateLunarProductivityRisk,
  getLatestLunarProductivityJobForUser,
  getLunarProductivitySettingsForUser,
  markLunarProductivityJobSeenForUser,
  resolveLunarProductivityImpactDirection,
  resolveLunarProductivityPushSeverity,
  upsertLunarProductivitySettingsForUser,
  fetchInterviewStrategyPlanForUser,
  maybeRefillInterviewStrategyWindowForUser,
  rebuildInterviewStrategyWindowForUser,
  upsertInterviewStrategySettingsForUser,
};

export async function registerNotificationRoutes(
  app: FastifyInstance,
  options: RegisterNotificationRoutesOptions = {},
): Promise<void> {
  const deps: NotificationRouteDependencies = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };

  app.put('/push-token', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const parsed = pushTokenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid push token payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const saved = await deps.upsertPushNotificationTokenForUser({
      userId: auth.user._id,
      token: parsed.data.token,
      platform: parsed.data.platform,
      appVersion: parsed.data.appVersion ?? null,
    });

    return {
      token: {
        platform: saved.platform,
        active: saved.active,
        updatedAt: saved.updatedAt.toISOString(),
        lastSeenAt: saved.lastSeenAt.toISOString(),
      },
    };
  });

  app.put('/burnout-settings', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const parsed = burnoutSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid burnout settings payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    if (!deps.isValidIanaTimezone(parsed.data.timezoneIana)) {
      return reply.code(400).send({
        error: 'Invalid burnout settings payload',
        details: {
          timezoneIana: ['Invalid IANA timezone identifier'],
        },
      });
    }

    if (parsed.data.workdayStartMinute >= parsed.data.workdayEndMinute) {
      return reply.code(400).send({
        error: 'Invalid burnout settings payload',
        details: {
          workdayStartMinute: ['workdayStartMinute must be earlier than workdayEndMinute'],
        },
      });
    }

    if (parsed.data.quietHoursStartMinute === parsed.data.quietHoursEndMinute) {
      return reply.code(400).send({
        error: 'Invalid burnout settings payload',
        details: {
          quietHoursStartMinute: ['quiet hours cannot span 24h; start and end cannot be equal'],
        },
      });
    }

    const settings = await deps.upsertBurnoutAlertSettingsForUser({
      userId: auth.user._id,
      enabled: parsed.data.enabled,
      timezoneIana: parsed.data.timezoneIana,
      workdayStartMinute: parsed.data.workdayStartMinute,
      workdayEndMinute: parsed.data.workdayEndMinute,
      quietHoursStartMinute: parsed.data.quietHoursStartMinute,
      quietHoursEndMinute: parsed.data.quietHoursEndMinute,
    });

    return { settings };
  });

  app.get('/burnout-plan', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const settings = await deps.getBurnoutAlertSettingsForUser(auth.user._id);

    try {
      const transit = await deps.getOrCreateDailyTransitForUser(
        auth.user._id,
        deps.buildTodayDate(),
        request.log,
        { includeAiSynergy: false }
      );
      const risk = deps.calculateBurnoutRisk(transit.doc);
      const latestJob = settings.enabled
        ? await deps.getLatestBurnoutAlertJobForUser(auth.user._id, transit.doc.dateKey)
        : null;
      const currentJob = isBurnoutAlertJobCurrentForTransit(latestJob, transit.doc) ? latestJob : null;
      const nextPlannedAt =
        settings.enabled && currentJob?.status === 'planned' && currentJob.scheduledAt
          ? currentJob.scheduledAt.toISOString()
          : null;

      return {
        dateKey: transit.doc.dateKey,
        enabled: settings.enabled,
        settings,
        risk: {
          algorithmVersion: risk.algorithmVersion,
          score: risk.riskScore,
          severity: risk.severity,
          components: risk.components,
          signals: risk.signals,
        },
        timing: {
          algorithmVersion: BURNOUT_TIMING_ALGORITHM_VERSION,
          nextPlannedAt,
          status: settings.enabled ? currentJob?.status ?? 'not_scheduled' : 'not_scheduled',
          scheduledDateKey: settings.enabled ? currentJob?.dateKey ?? null : null,
          scheduledSeverity: settings.enabled ? currentJob?.severity ?? null : null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Birth profile not found')) {
        return reply.code(404).send({ error: 'Birth profile not found. Complete onboarding first.' });
      }
      request.log.error({ error }, 'burnout plan request failed');
      return reply.code(502).send({ error: 'Unable to build burnout plan' });
    }
  });

  app.post('/burnout-seen', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const parsed = burnoutSeenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid burnout seen payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const transit = await deps.getOrCreateDailyTransitForUser(
        auth.user._id,
        deps.buildTodayDate(),
        request.log,
        { includeAiSynergy: false }
      );
      const risk = deps.calculateBurnoutRisk(transit.doc);
      const pushSeverity = deps.resolveBurnoutPushSeverity({
        riskScore: risk.riskScore,
        riskSeverity: risk.severity,
      });

      if (parsed.data.dateKey !== transit.doc.dateKey) {
        return {
          acknowledged: false,
          reason: 'date_mismatch',
          dateKey: transit.doc.dateKey,
          timingStatus: 'not_scheduled',
        };
      }

      if (!pushSeverity) {
        return {
          acknowledged: false,
          reason: 'below_threshold',
          dateKey: transit.doc.dateKey,
          timingStatus: 'not_scheduled',
        };
      }

      const result = await deps.markBurnoutAlertJobSeenForUser({
        userId: auth.user._id,
        profileHash: transit.doc.profileHash,
        dateKey: transit.doc.dateKey,
        transitGeneratedAt: transit.doc.generatedAt,
        riskScore: risk.riskScore,
        severity: pushSeverity,
      });

      return {
        acknowledged: result.status !== 'already_sent',
        reason: result.status === 'already_sent' ? 'already_sent' : null,
        dateKey: transit.doc.dateKey,
        timingStatus: result.status === 'already_sent' ? 'sent' : 'cancelled',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Birth profile not found')) {
        return reply.code(404).send({ error: 'Birth profile not found. Complete onboarding first.' });
      }
      request.log.error({ error }, 'burnout seen acknowledgement failed');
      return reply.code(502).send({ error: 'Unable to acknowledge burnout insight' });
    }
  });

  app.put('/lunar-productivity-settings', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const parsed = lunarProductivitySettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid lunar productivity settings payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    if (!deps.isValidIanaTimezone(parsed.data.timezoneIana)) {
      return reply.code(400).send({
        error: 'Invalid lunar productivity settings payload',
        details: {
          timezoneIana: ['Invalid IANA timezone identifier'],
        },
      });
    }

    if (parsed.data.workdayStartMinute >= parsed.data.workdayEndMinute) {
      return reply.code(400).send({
        error: 'Invalid lunar productivity settings payload',
        details: {
          workdayStartMinute: ['workdayStartMinute must be earlier than workdayEndMinute'],
        },
      });
    }

    if (parsed.data.quietHoursStartMinute === parsed.data.quietHoursEndMinute) {
      return reply.code(400).send({
        error: 'Invalid lunar productivity settings payload',
        details: {
          quietHoursStartMinute: ['quiet hours cannot span 24h; start and end cannot be equal'],
        },
      });
    }

    const settings = await deps.upsertLunarProductivitySettingsForUser({
      userId: auth.user._id,
      enabled: parsed.data.enabled,
      timezoneIana: parsed.data.timezoneIana,
      workdayStartMinute: parsed.data.workdayStartMinute,
      workdayEndMinute: parsed.data.workdayEndMinute,
      quietHoursStartMinute: parsed.data.quietHoursStartMinute,
      quietHoursEndMinute: parsed.data.quietHoursEndMinute,
    });

    return { settings };
  });

  app.get('/lunar-productivity-plan', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const settings = await deps.getLunarProductivitySettingsForUser(auth.user._id);

    try {
      const transit = await deps.getOrCreateDailyTransitForUser(
        auth.user._id,
        deps.buildTodayDate(),
        request.log,
        { includeAiSynergy: false }
      );
      const risk = deps.calculateLunarProductivityRisk(transit.doc);
      const latestJob = settings.enabled
        ? await deps.getLatestLunarProductivityJobForUser(auth.user._id, transit.doc.dateKey)
        : null;
      const currentJob = isLunarProductivityJobCurrentForTransit(latestJob, transit.doc) ? latestJob : null;
      const nextPlannedAt =
        settings.enabled && currentJob?.status === 'planned' && currentJob.scheduledAt
          ? currentJob.scheduledAt.toISOString()
          : null;

      return {
        dateKey: transit.doc.dateKey,
        enabled: settings.enabled,
        settings,
        risk: {
          algorithmVersion: risk.algorithmVersion,
          score: risk.riskScore,
          severity: risk.severity,
          impactDirection: deps.resolveLunarProductivityImpactDirection(risk.riskScore) ?? null,
          components: risk.components,
          signals: risk.signals,
        },
        timing: {
          algorithmVersion: LUNAR_PRODUCTIVITY_TIMING_ALGORITHM_VERSION,
          nextPlannedAt,
          status: settings.enabled ? currentJob?.status ?? 'not_scheduled' : 'not_scheduled',
          scheduledDateKey: settings.enabled ? currentJob?.dateKey ?? null : null,
          scheduledSeverity: settings.enabled ? currentJob?.severity ?? null : null,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Birth profile not found')) {
        return reply.code(404).send({ error: 'Birth profile not found. Complete onboarding first.' });
      }
      request.log.error({ error }, 'lunar productivity plan request failed');
      return reply.code(502).send({ error: 'Unable to build lunar productivity plan' });
    }
  });

  app.post('/lunar-productivity-seen', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const parsed = lunarProductivitySeenSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid lunar productivity seen payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    try {
      const transit = await deps.getOrCreateDailyTransitForUser(
        auth.user._id,
        deps.buildTodayDate(),
        request.log,
        { includeAiSynergy: false }
      );
      const risk = deps.calculateLunarProductivityRisk(transit.doc);
      const impactDirection = deps.resolveLunarProductivityImpactDirection(risk.riskScore);
      const pushSeverity = deps.resolveLunarProductivityPushSeverity({
        riskScore: risk.riskScore,
        riskSeverity: risk.severity,
      });

      if (parsed.data.dateKey !== transit.doc.dateKey) {
        return {
          acknowledged: false,
          reason: 'date_mismatch',
          dateKey: transit.doc.dateKey,
          impactDirection,
          timingStatus: 'not_scheduled',
        };
      }

      if (!impactDirection || !pushSeverity) {
        return {
          acknowledged: false,
          reason: 'outside_display_range',
          dateKey: transit.doc.dateKey,
          impactDirection: null,
          timingStatus: 'not_scheduled',
        };
      }

      const result = await deps.markLunarProductivityJobSeenForUser({
        userId: auth.user._id,
        profileHash: transit.doc.profileHash,
        dateKey: transit.doc.dateKey,
        transitGeneratedAt: transit.doc.generatedAt,
        riskScore: risk.riskScore,
        severity: pushSeverity,
        impactDirection,
      });

      return {
        acknowledged: result.status !== 'already_sent',
        reason: result.status === 'already_sent' ? 'already_sent' : null,
        dateKey: transit.doc.dateKey,
        impactDirection,
        timingStatus: result.status === 'already_sent' ? 'sent' : 'cancelled',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Birth profile not found')) {
        return reply.code(404).send({ error: 'Birth profile not found. Complete onboarding first.' });
      }
      request.log.error({ error }, 'lunar productivity seen acknowledgement failed');
      return reply.code(502).send({ error: 'Unable to acknowledge lunar productivity insight' });
    }
  });

  app.put('/interview-strategy-settings', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const parsed = interviewStrategySettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid interview strategy settings payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    if (!deps.isValidIanaTimezone(parsed.data.timezoneIana)) {
      return reply.code(400).send({
        error: 'Invalid interview strategy settings payload',
        details: {
          timezoneIana: ['Invalid IANA timezone identifier'],
        },
      });
    }

    if (parsed.data.workdayStartMinute >= parsed.data.workdayEndMinute) {
      return reply.code(400).send({
        error: 'Invalid interview strategy settings payload',
        details: {
          workdayStartMinute: ['workdayStartMinute must be earlier than workdayEndMinute'],
        },
      });
    }

    if (parsed.data.quietHoursStartMinute === parsed.data.quietHoursEndMinute) {
      return reply.code(400).send({
        error: 'Invalid interview strategy settings payload',
        details: {
          quietHoursStartMinute: ['quiet hours cannot span 24h; start and end cannot be equal'],
        },
      });
    }

    try {
      const settings = await deps.upsertInterviewStrategySettingsForUser({
        userId: auth.user._id,
        enabled: parsed.data.enabled,
        timezoneIana: parsed.data.timezoneIana,
        slotDurationMinutes: parsed.data.slotDurationMinutes,
        allowedWeekdays: parsed.data.allowedWeekdays,
        workdayStartMinute: parsed.data.workdayStartMinute,
        workdayEndMinute: parsed.data.workdayEndMinute,
        quietHoursStartMinute: parsed.data.quietHoursStartMinute,
        quietHoursEndMinute: parsed.data.quietHoursEndMinute,
        slotsPerWeek: parsed.data.slotsPerWeek,
      });

      return { settings };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Birth profile not found')) {
        return reply.code(404).send({ error: 'Birth profile not found. Complete onboarding first.' });
      }
      if (message.includes('Natal chart not found')) {
        return reply.code(404).send({ error: 'Natal chart not found. Generate natal chart first.' });
      }
      request.log.error({ error }, 'failed to upsert interview strategy settings');
      return reply.code(502).send({ error: 'Unable to save interview strategy settings' });
    }
  });

  app.get('/interview-strategy-plan', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    if (auth.user.subscriptionTier !== 'premium') {
      return reply.code(403).send({ error: 'Premium required', code: 'premium_required' });
    }

    const queryParsed = interviewStrategyPlanQuerySchema.safeParse(request.query ?? {});
    if (!queryParsed.success) {
      return reply.code(400).send({
        error: 'Invalid interview strategy query',
        details: queryParsed.error.flatten().fieldErrors,
      });
    }

    try {
      const shouldRefresh = queryParsed.data.refresh === 'true';
      if (shouldRefresh) {
        await deps.rebuildInterviewStrategyWindowForUser({
          userId: auth.user._id,
          logger: request.log,
          source: 'manual_refresh',
          llmMode: 'background',
        });
      } else {
        await deps.maybeRefillInterviewStrategyWindowForUser({
          userId: auth.user._id,
          logger: request.log,
          source: 'bootstrap',
          llmMode: 'background',
        });
      }

      const payload = await deps.fetchInterviewStrategyPlanForUser({
        userId: auth.user._id,
      });
      return payload;
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (message.includes('Birth profile not found')) {
        return reply.code(404).send({ error: 'Birth profile not found. Complete onboarding first.' });
      }
      if (message.includes('Natal chart not found')) {
        return reply.code(404).send({ error: 'Natal chart not found. Generate natal chart first.' });
      }
      if (message.includes('Daily transit data unavailable')) {
        return reply.code(502).send({ error: 'Daily transit data unavailable for interview strategy generation.' });
      }
      request.log.error({ error }, 'failed to fetch interview strategy plan');
      return reply.code(502).send({ error: 'Unable to build interview strategy plan' });
    }
  });
}
