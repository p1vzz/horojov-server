import type { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
import { z } from 'zod';
import { env } from '../config/env.js';
import { getCollections } from '../db/mongo.js';
import { authenticateByAuthorizationHeader, toPublicUser } from '../services/auth.js';
import { getBillingSnapshotForUser, syncRevenueCatForAppUserId, syncRevenueCatForUser } from '../services/billingSync.js';

export type BillingRouteDependencies = {
  authenticateByAuthorizationHeader: typeof authenticateByAuthorizationHeader;
  toPublicUser: typeof toPublicUser;
  getBillingSnapshotForUser: typeof getBillingSnapshotForUser;
  syncRevenueCatForUser: typeof syncRevenueCatForUser;
  syncRevenueCatForAppUserId: typeof syncRevenueCatForAppUserId;
  getCollections: typeof getCollections;
  expectedWebhookAuthorization: typeof expectedWebhookAuthorization;
};

export type RegisterBillingRoutesOptions = {
  deps?: Partial<BillingRouteDependencies>;
};

const revenueCatWebhookSchema = z.object({
  event: z
    .object({
      id: z.string().trim().min(1),
      type: z.string().trim().min(1).optional(),
      app_user_id: z.string().trim().min(1).optional(),
      event_timestamp_ms: z.coerce.number().int().optional(),
    })
    .passthrough(),
});

function normalizeAuthHeader(authorization?: string) {
  if (!authorization) return '';
  return authorization.trim();
}

function expectedWebhookAuthorization() {
  const token = env.REVENUECAT_WEBHOOK_AUTH_TOKEN?.trim();
  if (!token) return null;
  return `Bearer ${token}`;
}

const defaultDeps: BillingRouteDependencies = {
  authenticateByAuthorizationHeader,
  toPublicUser,
  getBillingSnapshotForUser,
  syncRevenueCatForUser,
  syncRevenueCatForAppUserId,
  getCollections,
  expectedWebhookAuthorization,
};

export async function registerBillingRoutes(
  app: FastifyInstance,
  options: RegisterBillingRoutesOptions = {},
): Promise<void> {
  const deps: BillingRouteDependencies = {
    ...defaultDeps,
    ...(options.deps ?? {}),
  };

  app.get('/subscription', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const subscription = await deps.getBillingSnapshotForUser(auth.user);
    return {
      user: deps.toPublicUser(auth.user),
      subscription,
    };
  });

  app.post('/revenuecat/sync', async (request, reply) => {
    const auth = await deps.authenticateByAuthorizationHeader(request.headers.authorization);
    if (!auth) {
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    try {
      const synced = await deps.syncRevenueCatForUser({
        userId: auth.user._id,
        source: 'sync',
      });
      return {
        user: deps.toPublicUser(synced.user),
        subscription: synced.subscription,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'RevenueCat sync failed';
      if (message.includes('not configured')) {
        return reply.code(500).send({ error: message });
      }
      request.log.error({ error }, 'manual RevenueCat sync failed');
      return reply.code(502).send({ error: 'Unable to sync subscription now' });
    }
  });

  app.post('/revenuecat/webhook', async (request, reply) => {
    const expectedAuthorization = deps.expectedWebhookAuthorization();
    if (!expectedAuthorization) {
      return reply.code(500).send({ error: 'RevenueCat webhook auth token is not configured' });
    }
    if (normalizeAuthHeader(request.headers.authorization) !== expectedAuthorization) {
      return reply.code(401).send({ error: 'Unauthorized webhook request' });
    }

    const parsed = revenueCatWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'Invalid RevenueCat webhook payload',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const payload = parsed.data;
    const eventId = payload.event.id;
    const eventType = payload.event.type ?? 'unknown';
    const appUserId = payload.event.app_user_id ?? null;
    const eventTimestampMs =
      typeof payload.event.event_timestamp_ms === 'number' && Number.isFinite(payload.event.event_timestamp_ms)
        ? payload.event.event_timestamp_ms
        : null;

    const collections = await deps.getCollections();
    const existing = await collections.revenueCatEvents.findOne({ eventId });
    if (existing && existing.processingStatus !== 'failed') {
      return { ok: true, duplicate: true };
    }

    const receivedAt = new Date();
    if (existing) {
      await collections.revenueCatEvents.updateOne(
        { eventId },
        {
          $set: {
            eventType,
            appUserId,
            userId: null,
            eventTimestampMs,
            receivedAt,
            processedAt: null,
            processingStatus: 'ignored',
            errorMessage: null,
            rawPayload: payload,
          },
        }
      );
    } else {
      await collections.revenueCatEvents.insertOne({
        _id: new ObjectId(),
        eventId,
        eventType,
        appUserId,
        userId: null,
        eventTimestampMs,
        receivedAt,
        processedAt: null,
        processingStatus: 'ignored',
        errorMessage: null,
        rawPayload: payload,
      });
    }

    try {
      const synced =
        appUserId && appUserId.length > 0
          ? await deps.syncRevenueCatForAppUserId({
              appUserId,
              source: 'webhook',
              latestEventId: eventId,
              latestEventAt: eventTimestampMs ? new Date(eventTimestampMs) : null,
            })
          : null;

      await collections.revenueCatEvents.updateOne(
        { eventId },
        {
          $set: {
            userId: synced?.user._id ?? null,
            processedAt: new Date(),
            processingStatus: synced ? 'processed' : 'ignored',
            errorMessage: null,
          },
        }
      );

      return {
        ok: true,
        status: synced ? 'processed' : 'ignored',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'RevenueCat webhook processing failed';
      await collections.revenueCatEvents.updateOne(
        { eventId },
        {
          $set: {
            processedAt: new Date(),
            processingStatus: 'failed',
            errorMessage: message,
          },
        }
      );
      request.log.error({ error }, 'RevenueCat webhook processing failed');
      return reply.code(500).send({ error: 'Webhook processing failed' });
    }
  });
}
