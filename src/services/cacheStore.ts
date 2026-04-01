import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { env } from '../config/env.js';
import { shouldAllowLocalSchedulerLockFallback } from '../runtime/runtimeProcessCore.js';

type LocalCacheEntry = {
  payload: string;
  expiresAtMs: number;
};

type LocalLockEntry = {
  token: string;
  expiresAtMs: number;
};

type LockAcquireResult =
  | {
      acquired: true;
      token: string;
      backend: 'redis' | 'local';
    }
  | {
      acquired: false;
      token: string;
      backend: 'redis' | 'local' | 'none';
      reason: 'busy' | 'backend_unavailable';
    };

type RedisClientLike = {
  isOpen: boolean;
  connect: () => Promise<void>;
  get: (key: string) => Promise<string | null>;
  set: (
    key: string,
    value: string,
    options?: Record<string, unknown>
  ) => Promise<unknown>;
  del: (key: string) => Promise<number>;
  quit: () => Promise<unknown>;
  destroy?: () => void;
  on: (event: string, listener: (...args: unknown[]) => void) => unknown;
};

const REDIS_RETRY_BACKOFF_MS = 30_000;

const localCacheStore = new Map<string, LocalCacheEntry>();
const localLockStore = new Map<string, LocalLockEntry>();

let redisClient: RedisClientLike | null = null;
let redisConnectPromise: Promise<RedisClientLike | null> | null = null;
let nextRedisRetryAtMs = 0;

function nowMs() {
  return Date.now();
}

function resolveStoreKey(key: string) {
  return `${env.REDIS_KEY_PREFIX}:${key}`;
}

function allowLocalSchedulerLockFallback() {
  return shouldAllowLocalSchedulerLockFallback({
    nodeEnv: env.NODE_ENV,
    redisEnabled: env.REDIS_ENABLED,
    redisUrl: env.REDIS_URL ?? '',
    schedulerLocksEnabled: env.SCHEDULER_LOCKS_ENABLED,
  });
}

function readLocalCache<T>(storeKey: string): T | null {
  const entry = localCacheStore.get(storeKey);
  if (!entry) return null;
  if (entry.expiresAtMs <= nowMs()) {
    localCacheStore.delete(storeKey);
    return null;
  }

  try {
    return JSON.parse(entry.payload) as T;
  } catch {
    localCacheStore.delete(storeKey);
    return null;
  }
}

function writeLocalCache(storeKey: string, value: unknown, ttlMs: number) {
  localCacheStore.set(storeKey, {
    payload: JSON.stringify(value),
    expiresAtMs: nowMs() + ttlMs,
  });
}

function tryAcquireLocalLock(storeKey: string, token: string, ttlMs: number) {
  const existing = localLockStore.get(storeKey);
  const now = nowMs();
  if (existing && existing.expiresAtMs > now) {
    return false;
  }
  localLockStore.set(storeKey, {
    token,
    expiresAtMs: now + ttlMs,
  });
  return true;
}

async function ensureRedisClient() {
  if (!env.REDIS_ENABLED || !env.REDIS_URL) return null;
  if (redisClient && redisClient.isOpen) return redisClient;
  if (redisConnectPromise) return redisConnectPromise;
  if (nowMs() < nextRedisRetryAtMs) return null;

  redisConnectPromise = (async () => {
    const client = createClient({
      url: env.REDIS_URL,
    }) as unknown as RedisClientLike;
    client.on('error', () => undefined);

    try {
      await client.connect();
      redisClient = client;
      nextRedisRetryAtMs = 0;
      return client;
    } catch {
      nextRedisRetryAtMs = nowMs() + REDIS_RETRY_BACKOFF_MS;
      try {
        if (typeof client.destroy === 'function') {
          client.destroy();
        }
      } catch {
        // ignore disconnect failures
      }
      return null;
    } finally {
      redisConnectPromise = null;
    }
  })();

  return redisConnectPromise;
}

export async function getCachedJson<T>(key: string): Promise<T | null> {
  const storeKey = resolveStoreKey(key);
  const redis = await ensureRedisClient();
  if (redis) {
    try {
      const raw = await redis.get(storeKey);
      if (raw === null) {
        localCacheStore.delete(storeKey);
        return null;
      }
      try {
        return JSON.parse(raw) as T;
      } catch {
        await redis.del(storeKey);
        localCacheStore.delete(storeKey);
        return null;
      }
    } catch {
      return readLocalCache<T>(storeKey);
    }
  }

  return readLocalCache<T>(storeKey);
}

export async function setCachedJson(
  key: string,
  value: unknown,
  ttlMs: number
): Promise<void> {
  const safeTtlMs = Math.max(1, Math.trunc(ttlMs));
  const storeKey = resolveStoreKey(key);

  writeLocalCache(storeKey, value, safeTtlMs);

  const redis = await ensureRedisClient();
  if (!redis) return;

  try {
    await redis.set(storeKey, JSON.stringify(value), { PX: safeTtlMs });
  } catch {
    // local cache fallback remains available
  }
}

export async function deleteCachedKey(key: string): Promise<void> {
  const storeKey = resolveStoreKey(key);
  localCacheStore.delete(storeKey);

  const redis = await ensureRedisClient();
  if (!redis) return;
  try {
    await redis.del(storeKey);
  } catch {
    // ignore eviction failures
  }
}

export async function tryAcquireLock(
  key: string,
  ttlMs: number
): Promise<LockAcquireResult> {
  const safeTtlMs = Math.max(1, Math.trunc(ttlMs));
  const storeKey = resolveStoreKey(key);
  const token = randomUUID();

  const redis = await ensureRedisClient();
  if (redis) {
    try {
      const result = await redis.set(storeKey, token, {
        PX: safeTtlMs,
        NX: true,
      });
      if (result === 'OK') {
        return { acquired: true, token, backend: 'redis' };
      }
      return { acquired: false, token, backend: 'redis', reason: 'busy' };
    } catch {
      if (!allowLocalSchedulerLockFallback()) {
        return { acquired: false, token, backend: 'none', reason: 'backend_unavailable' };
      }
      const acquired = tryAcquireLocalLock(storeKey, token, safeTtlMs);
      if (acquired) {
        return { acquired: true, token, backend: 'local' };
      }
      return { acquired: false, token, backend: 'local', reason: 'busy' };
    }
  }

  if (!allowLocalSchedulerLockFallback()) {
    return { acquired: false, token, backend: 'none', reason: 'backend_unavailable' };
  }

  const acquired = tryAcquireLocalLock(storeKey, token, safeTtlMs);
  if (acquired) {
    return { acquired: true, token, backend: 'local' };
  }
  return { acquired: false, token, backend: 'local', reason: 'busy' };
}

export async function releaseLock(key: string, token: string): Promise<void> {
  const storeKey = resolveStoreKey(key);

  const redis = await ensureRedisClient();
  if (redis) {
    try {
      const current = await redis.get(storeKey);
      if (current === token) {
        await redis.del(storeKey);
      }
      return;
    } catch {
      if (!allowLocalSchedulerLockFallback()) {
        return;
      }
      // fallback to local lock release below
    }
  }

  const localLock = localLockStore.get(storeKey);
  if (localLock?.token === token) {
    localLockStore.delete(storeKey);
  }
}

export async function closeCacheStoreConnection() {
  localCacheStore.clear();
  localLockStore.clear();

  if (redisConnectPromise) {
    await redisConnectPromise.catch(() => null);
    redisConnectPromise = null;
  }

  if (redisClient && redisClient.isOpen) {
    try {
      await redisClient.quit();
    } catch {
      try {
        if (typeof redisClient.destroy === 'function') {
          redisClient.destroy();
        }
      } catch {
        // ignore hard close failures
      }
    }
  }

  redisClient = null;
  nextRedisRetryAtMs = 0;
}
