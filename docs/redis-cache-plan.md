# Redis Cache Plan (Draft)

Date: 2026-03-25  
Status: partially implemented (updated 2026-03-29)

## Current implementation snapshot

Implemented in code:

- shared cache/lock adapter with local fallback (`src/services/cacheStore.ts`)
- optional Redis enablement via `REDIS_ENABLED` + `REDIS_URL`
- scheduler lock policy wired through `src/services/schedulerLockPolicy.ts`
- job metrics snapshot caching (`CACHE_JOB_METRICS_SNAPSHOT_ENABLED`)

Not implemented yet:

- full endpoint-level cache rollout from the draft target list
- namespace-by-namespace cache policy docs tied to production metrics

## Goals

- reduce latency on hot endpoints;
- reduce MongoDB read/write load;
- avoid duplicated expensive daily computations;
- prepare for horizontal scaling (shared cache + distributed locks).

## Priority cache targets

### 1) City search (quick win)

- Key: `city:search:v1:{language}:{query}:{count}`
- Value: `/api/cities/search` response (`items`)
- TTL: `1h` (up to `6h` if needed)
- Invalidation: TTL-only
- Purpose: remove repeated Open-Meteo calls for identical queries.

### 2) Auth token context

- Key: `auth:access:v1:{accessTokenHash}`
- Value: `{ userId, sessionId, tier, expiresAt }`
- TTL: until `accessExpiresAt` (or `max 1h`)
- Invalidation:
  - delete on logout/refresh/revoke;
  - natural expiration by TTL
- Purpose: reduce frequent `sessions/users` reads on protected endpoints.

### 3) Daily transit

- Key: `daily-transit:v2:{userId}:{profileHash}:{dateKey}`
- Value: serialized daily transit payload
- TTL: `36h`
- Invalidation:
  - on birth-profile update (profileHash changes; old keys can expire naturally);
  - overwrite on forced regenerate
- Purpose: avoid rebuilding transit multiple times per day.

### 4) AI synergy

- Key: `ai-synergy:v2:{userId}:{profileHash}:{dateKey}`
- Value: computed AI synergy payload
- TTL: `36h`
- Invalidation:
  - versioned namespace on algorithm bump (`v2 -> v3`);
  - overwrite on forced regenerate
- Purpose: reduce CPU and repeated LLM calls.

### 5) Morning briefing

- Key: `morning-briefing:v2:{userId}:{profileHash}:{dateKey}`
- Value: final morning briefing response
- TTL: until `staleAfter` + buffer (`max 36h`)
- Invalidation:
  - premium downgrade does not require hard delete (access is auth-gated);
  - overwrite on `refresh=true`
- Purpose: speed up premium flow and reduce duplicate Mongo reads.

### 6) Discover roles catalog

- Key: `discover:catalog:v1`
- Value: active role catalog
- TTL: `12h-24h`
- Invalidation:
  - explicit delete/set after catalog reseed
- Purpose: avoid loading full `discover_role_catalog` from Mongo every request.

### 7) Jobs preflight snapshot

- Key: `jobs:preflight:v1:{canonicalUrlHash}:{parserVersion}:{rubricVersion}:{modelVersion}`
- Value: preflight summary (`cache hits`, `nextStage`, `versions`)
- TTL: `5m-15m`
- Invalidation:
  - TTL-based;
  - optional delete on updates to `jobs_raw/jobs_parsed/job_analyses`
- Purpose: reduce burst load on repeated preflight calls.

## Distributed locks (multi-instance safety)

### Daily transit scheduler
- Lock key: `lock:daily-transit:{dateKey}`
- Lock TTL: `5m-15m`

### Job metrics scheduler
- Lock key: `lock:job-metrics:{windowHours}:{bucket}`
- Lock TTL: `2m-5m`

### Burnout alert scheduler
- Lock key: `lock:burnout-alerts:{slot}`
- Lock TTL: `2m-5m`

Requirement: best-effort locks with safe fallback when lock expires.

## Rollout plan

1. Add Redis client + basic cache helper (`get/set/del`, JSON, TTL).
2. Add city cache and auth cache (low risk, high impact).
3. Add daily-transit + ai-synergy + morning-briefing cache.
4. Add discover catalog cache and preflight cache.
5. Add distributed locks in schedulers.
6. Enable gradually using env flags.

## Proposed env flags

- `REDIS_URL`
- `REDIS_ENABLED=true|false`
- `REDIS_KEY_PREFIX=horojob`
- `REDIS_DEFAULT_TTL_SECONDS=300`
- `CACHE_AUTH_ENABLED=true|false`
- `CACHE_CITY_ENABLED=true|false`
- `CACHE_DAILY_TRANSIT_ENABLED=true|false`
- `CACHE_AI_SYNERGY_ENABLED=true|false`
- `CACHE_MORNING_BRIEFING_ENABLED=true|false`
- `CACHE_DISCOVER_ROLES_ENABLED=true|false`
- `CACHE_JOBS_PREFLIGHT_ENABLED=true|false`
- `SCHEDULER_LOCKS_ENABLED=true|false`

## Metrics and controls

- hit/miss ratio per namespace;
- latency p50/p95/p99 before/after rollout;
- Mongo query rate for affected collections;
- Redis error rate (timeouts, connection issues);
- lock contention / skipped scheduler runs.

## Readiness criteria

- Redis availability and failure-mode agreement;
- final env flags and default values defined;
- smoke checks prepared for:
  - `/api/cities/search`
  - `/api/astrology/daily-transit`
  - `/api/astrology/morning-briefing`
  - `/api/jobs/preflight`
