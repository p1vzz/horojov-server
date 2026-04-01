import { env } from '../config/env.js';

export type RevenueCatSubscriberEntitlement = {
  product_identifier?: string | null;
  purchase_date?: string | null;
  expires_date?: string | null;
};

export type RevenueCatSubscription = {
  store?: string | null;
  is_sandbox?: boolean;
  purchase_date?: string | null;
  expires_date?: string | null;
  grace_period_expires_date?: string | null;
  period_type?: string | null;
  unsubscribe_detected_at?: string | null;
  billing_issues_detected_at?: string | null;
};

export type RevenueCatSubscriber = {
  entitlements?: Record<string, RevenueCatSubscriberEntitlement>;
  subscriptions?: Record<string, RevenueCatSubscription>;
};

type RevenueCatSubscriberResponse = {
  subscriber?: RevenueCatSubscriber;
};

export class RevenueCatError extends Error {
  status: number;
  payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function normalizeBaseUrl(input: string) {
  return input.replace(/\/+$/, '');
}

function parseUnknownJson(input: string) {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return { raw: input };
  }
}

function assertConfigured() {
  if (!env.REVENUECAT_SECRET_API_KEY) {
    throw new RevenueCatError(500, 'RevenueCat secret API key is not configured', null);
  }
}

export async function fetchRevenueCatSubscriber(appUserId: string): Promise<RevenueCatSubscriber> {
  assertConfigured();

  const response = await fetch(
    `${normalizeBaseUrl(env.REVENUECAT_API_BASE_URL)}/subscribers/${encodeURIComponent(appUserId)}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.REVENUECAT_SECRET_API_KEY}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(env.REVENUECAT_REQUEST_TIMEOUT_MS),
    }
  );

  const raw = await response.text();
  const payload = parseUnknownJson(raw);
  if (!response.ok) {
    throw new RevenueCatError(response.status, 'RevenueCat subscriber request failed', payload);
  }

  const parsed = payload as RevenueCatSubscriberResponse;
  if (!parsed?.subscriber || typeof parsed.subscriber !== 'object') {
    throw new RevenueCatError(502, 'RevenueCat response has invalid subscriber payload', payload);
  }

  return parsed.subscriber;
}
