import { ObjectId } from 'mongodb';
import { env } from '../config/env.js';
import { getCollections, type BillingSubscriptionDoc, type UserDoc } from '../db/mongo.js';
import { fetchRevenueCatSubscriber } from './revenuecatClient.js';
import { projectRevenueCatSubscriptionState } from './subscriptionProjection.js';

export type BillingSyncSource = 'sync' | 'webhook';

export type PublicBillingSnapshot = {
  provider: 'revenuecat';
  tier: 'free' | 'premium';
  entitlementId: string | null;
  status: BillingSubscriptionDoc['status'];
  expiresAt: string | null;
  willRenew: boolean | null;
  productId: string | null;
  updatedAt: string;
};

function resolveEffectiveTier(tier: 'free' | 'premium') {
  return env.DEV_FORCE_PREMIUM_FOR_ALL_USERS ? 'premium' : tier;
}

function assertRevenueCatConfigured() {
  if (!env.REVENUECAT_SECRET_API_KEY) {
    throw new Error('RevenueCat secret API key is not configured');
  }
}

function toPublicSnapshotFromDoc(doc: BillingSubscriptionDoc): PublicBillingSnapshot {
  return {
    provider: doc.provider,
    tier: resolveEffectiveTier(doc.tier),
    entitlementId: doc.entitlementId,
    status: doc.status,
    expiresAt: doc.expiresAt ? doc.expiresAt.toISOString() : null,
    willRenew: doc.willRenew,
    productId: doc.productId,
    updatedAt: doc.updatedAt.toISOString(),
  };
}

function toPublicSnapshotFromUser(user: UserDoc): PublicBillingSnapshot {
  return {
    provider: 'revenuecat',
    tier: resolveEffectiveTier(user.subscriptionTier === 'premium' ? 'premium' : 'free'),
    entitlementId: null,
    status: 'none',
    expiresAt: null,
    willRenew: null,
    productId: null,
    updatedAt: user.updatedAt.toISOString(),
  };
}

export async function getBillingSnapshotForUser(user: UserDoc): Promise<PublicBillingSnapshot> {
  const collections = await getCollections();
  const existing = await collections.billingSubscriptions.findOne({ userId: user._id });
  if (!existing) {
    return toPublicSnapshotFromUser(user);
  }
  return toPublicSnapshotFromDoc(existing);
}

export async function syncRevenueCatForUser(options: {
  userId: ObjectId;
  source: BillingSyncSource;
  latestEventId?: string | null;
  latestEventAt?: Date | null;
}) {
  assertRevenueCatConfigured();
  const collections = await getCollections();
  const user = await collections.users.findOne({ _id: options.userId });
  if (!user) {
    throw new Error('User not found');
  }

  const appUserId = user._id.toHexString();
  const subscriber = await fetchRevenueCatSubscriber(appUserId);
  const projected = projectRevenueCatSubscriptionState({ subscriber, now: new Date() });
  const now = new Date();

  await collections.billingSubscriptions.updateOne(
    { userId: user._id },
    {
      $set: {
        provider: 'revenuecat',
        appUserId,
        tier: projected.tier,
        entitlementId: projected.entitlementId,
        status: projected.status,
        productId: projected.productId,
        store: projected.store,
        willRenew: projected.willRenew,
        periodType: projected.periodType,
        purchasedAt: projected.purchasedAt,
        expiresAt: projected.expiresAt,
        latestEventId: options.latestEventId ?? null,
        latestEventAt: options.latestEventAt ?? null,
        source: options.source,
        rawSnapshot: subscriber,
        updatedAt: now,
      },
      $setOnInsert: {
        _id: new ObjectId(),
        createdAt: now,
      },
    },
    { upsert: true }
  );

  await collections.users.updateOne(
    { _id: user._id },
    {
      $set: {
        subscriptionTier: projected.tier,
        updatedAt: now,
      },
    }
  );

  const updatedUser = await collections.users.findOne({ _id: user._id });
  if (!updatedUser) {
    throw new Error('Updated user not found');
  }

  const billingDoc = await collections.billingSubscriptions.findOne({ userId: user._id });
  if (!billingDoc) {
    throw new Error('Billing subscription snapshot missing after sync');
  }

  return {
    user: updatedUser,
    subscription: toPublicSnapshotFromDoc(billingDoc),
  };
}

export async function syncRevenueCatForAppUserId(options: {
  appUserId: string;
  source: BillingSyncSource;
  latestEventId?: string | null;
  latestEventAt?: Date | null;
}) {
  if (!ObjectId.isValid(options.appUserId)) {
    return null;
  }
  const userId = new ObjectId(options.appUserId);
  const collections = await getCollections();
  const user = await collections.users.findOne({ _id: userId });
  if (!user) {
    return null;
  }
  return syncRevenueCatForUser({
    userId,
    source: options.source,
    latestEventId: options.latestEventId ?? null,
    latestEventAt: options.latestEventAt ?? null,
  });
}
