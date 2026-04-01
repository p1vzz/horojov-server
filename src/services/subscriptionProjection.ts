import { env } from '../config/env.js';
import type { BillingSubscriptionDoc, BillingSubscriptionStatus } from '../db/mongo.js';
import type { RevenueCatSubscriber, RevenueCatSubscription } from './revenuecatClient.js';

type ProjectedBillingState = Pick<
  BillingSubscriptionDoc,
  | 'tier'
  | 'entitlementId'
  | 'status'
  | 'productId'
  | 'store'
  | 'willRenew'
  | 'periodType'
  | 'purchasedAt'
  | 'expiresAt'
>;

function parseDateOrNull(input: unknown) {
  if (typeof input !== 'string') return null;
  const timestamp = Date.parse(input);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp);
}

function normalizeStore(input: unknown): BillingSubscriptionDoc['store'] {
  const value = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (value === 'app_store') return 'app_store';
  if (value === 'play_store') return 'play_store';
  if (value === 'stripe') return 'stripe';
  if (value === 'promotional') return 'promotional';
  return 'unknown';
}

function normalizePeriodType(input: unknown): BillingSubscriptionDoc['periodType'] {
  const value = typeof input === 'string' ? input.trim().toLowerCase() : '';
  if (value === 'normal') return 'normal';
  if (value === 'trial') return 'trial';
  if (value === 'intro') return 'intro';
  if (value === 'prepaid') return 'prepaid';
  return value.length > 0 ? 'unknown' : null;
}

function resolveStatus(input: {
  expiresAt: Date | null;
  graceExpiresAt: Date | null;
  billingIssueAt: Date | null;
  now: Date;
}): BillingSubscriptionStatus {
  if (!input.expiresAt) {
    if (input.billingIssueAt) return 'billing_issue';
    return 'active';
  }
  if (input.expiresAt.getTime() > input.now.getTime()) {
    if (input.billingIssueAt) return 'billing_issue';
    if (input.graceExpiresAt && input.graceExpiresAt.getTime() > input.now.getTime()) return 'grace';
    return 'active';
  }
  return 'expired';
}

function resolveWillRenew(subscription: RevenueCatSubscription | null, now: Date) {
  if (!subscription) return null;
  const expiresAt = parseDateOrNull(subscription.expires_date);
  if (expiresAt && expiresAt.getTime() <= now.getTime()) return false;
  const unsubscribeAt = parseDateOrNull(subscription.unsubscribe_detected_at);
  if (unsubscribeAt) return false;
  return true;
}

export function projectRevenueCatSubscriptionState(input: { subscriber: RevenueCatSubscriber; now?: Date }): ProjectedBillingState {
  const now = input.now ?? new Date();
  const entitlementId = env.REVENUECAT_ENTITLEMENT_PREMIUM;
  const entitlementRaw =
    input.subscriber.entitlements && typeof input.subscriber.entitlements === 'object'
      ? input.subscriber.entitlements[entitlementId]
      : undefined;

  if (!entitlementRaw || typeof entitlementRaw !== 'object') {
    return {
      tier: 'free',
      entitlementId: null,
      status: 'none',
      productId: null,
      store: 'unknown',
      willRenew: null,
      periodType: null,
      purchasedAt: null,
      expiresAt: null,
    };
  }

  const productId = typeof entitlementRaw.product_identifier === 'string' ? entitlementRaw.product_identifier : null;
  const subscriptions = input.subscriber.subscriptions;
  const subscriptionRaw =
    productId && subscriptions && typeof subscriptions === 'object' && subscriptions[productId] && typeof subscriptions[productId] === 'object'
      ? subscriptions[productId]
      : null;

  const expiresAt = parseDateOrNull(entitlementRaw.expires_date);
  const graceExpiresAt = parseDateOrNull(subscriptionRaw?.grace_period_expires_date);
  const billingIssueAt = parseDateOrNull(subscriptionRaw?.billing_issues_detected_at);

  const status = resolveStatus({
    expiresAt,
    graceExpiresAt,
    billingIssueAt,
    now,
  });
  const tier = status === 'expired' ? 'free' : 'premium';

  return {
    tier,
    entitlementId,
    status,
    productId,
    store: normalizeStore(subscriptionRaw?.store),
    willRenew: resolveWillRenew(subscriptionRaw, now),
    periodType: normalizePeriodType(subscriptionRaw?.period_type),
    purchasedAt: parseDateOrNull(entitlementRaw.purchase_date),
    expiresAt,
  };
}
