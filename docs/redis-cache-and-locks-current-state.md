# Redis Cache And Locks - Current State
**Status:** Active  
**Last synced:** 2026-04-10

## Goal

Describe what Redis-backed behavior is actually implemented now (not planned), including fallback behavior and lock scopes.

## Runtime Design

Implementation lives in:

- `src/services/cacheStore.ts`
- `src/services/schedulerLockPolicy.ts`

Model:

- optional Redis client (`REDIS_ENABLED=true` + valid `REDIS_URL`)
- always-on in-process fallback maps:
  - JSON cache map
  - lock map
- all keys are prefixed: `${REDIS_KEY_PREFIX}:<key>`

If Redis connect/read/write fails:
- JSON cache continues with local fallback.
- Scheduler locks continue with local fallback only outside `production`.
- In `production`, scheduler lock acquisition fails closed and worker cycle is skipped.

## Connection And Failure Behavior

- lazy connection on first cache/lock operation
- reconnect backoff after connect failure: 30s
- JSON parse-safe reads:
  - malformed payloads are evicted
- shutdown path closes Redis cleanly (`quit`/`destroy`) and clears local stores

## Current Cache Usage (Implemented)

### Job metrics snapshot cache

Namespace:

- `jobs:metrics:v1:<windowHours>`

Used by:

- `collectJobMetrics` in `src/services/jobMetrics.ts`

Controls:

- `CACHE_JOB_METRICS_SNAPSHOT_ENABLED`
- `CACHE_JOB_METRICS_SNAPSHOT_TTL_SECONDS`

Behavior:

- serves cached report when available
- deduplicates concurrent in-flight collection per `windowHours`
- supports targeted/global invalidation via `clearJobMetricsSnapshotCache`

## Distributed Scheduler Locks (Implemented)

All locks use `tryAcquireLock` + TTL and release by token.

Gate:

- `SCHEDULER_LOCKS_ENABLED`
- defaults to `true` in `production` when unset

Keys by scheduler:

- `lock:daily-transit:<dateKey>`
- `lock:job-metrics:<windowHours>:<bucket>`
- `lock:burnout-alerts:<bucket>`
- `lock:lunar-productivity:<bucket>`
- `lock:interview-strategy:<bucket>`

TTL controls:

- `SCHEDULER_LOCK_DAILY_TRANSIT_TTL_SECONDS`
- `SCHEDULER_LOCK_JOB_METRICS_TTL_SECONDS`
- `SCHEDULER_LOCK_BURNOUT_ALERTS_TTL_SECONDS`
- `SCHEDULER_LOCK_LUNAR_PRODUCTIVITY_TTL_SECONDS`
- `SCHEDULER_LOCK_INTERVIEW_STRATEGY_TTL_SECONDS`

Schedulers using lock wrapper:

- `startDailyTransitScheduler`
- `startJobMetricsAlertScheduler`
- `startBurnoutAlertScheduler`
- `startLunarProductivityScheduler`
- `startInterviewStrategyScheduler`

## Worker Runtime Safety

- `src/worker.ts` validates scheduler runtime before boot.
- In `production`, worker startup requires:
  - `REDIS_ENABLED=true`
  - valid `REDIS_URL`
  - `SCHEDULER_LOCKS_ENABLED=true`
- If Redis becomes unavailable during a production worker cycle, lock acquisition returns `backend_unavailable` and the scheduler cycle is skipped instead of falling back to in-memory local locks.

## Not Implemented Yet (vs draft plan)

- endpoint-level response cache rollout (cities/auth/daily-transit/morning-briefing/etc.)
- additional namespace metrics dashboards and hit-rate reporting beyond job-metrics use case

Those items remain in planning doc: `docs/redis-cache-plan.md`.

## Env Keys (Current Set)

- `REDIS_ENABLED`
- `REDIS_URL`
- `REDIS_KEY_PREFIX`
- `CACHE_JOB_METRICS_SNAPSHOT_ENABLED`
- `CACHE_JOB_METRICS_SNAPSHOT_TTL_SECONDS`
- `SCHEDULER_LOCKS_ENABLED`
- `SCHEDULER_LOCK_DAILY_TRANSIT_TTL_SECONDS`
- `SCHEDULER_LOCK_JOB_METRICS_TTL_SECONDS`
- `SCHEDULER_LOCK_BURNOUT_ALERTS_TTL_SECONDS`
- `SCHEDULER_LOCK_LUNAR_PRODUCTIVITY_TTL_SECONDS`
- `SCHEDULER_LOCK_INTERVIEW_STRATEGY_TTL_SECONDS`

## Source Files

- `src/services/cacheStore.ts`
- `src/services/schedulerLockPolicy.ts`
- `src/runtime/runtimeProcessCore.ts`
- `src/worker.ts`
- `src/services/jobMetrics.ts`
- `src/services/dailyTransitScheduler.ts`
- `src/services/jobMetricsAlertScheduler.ts`
- `src/services/burnoutAlertScheduler.ts`
- `src/services/lunarProductivityScheduler.ts`
- `src/services/interviewStrategyScheduler.ts`
