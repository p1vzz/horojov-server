# Mongo Collections And Indexes
**Status:** Active  
**Last synced:** 2026-04-24

## Goal

Keep one readable reference of current Mongo collections and index strategy implemented in `src/db/mongo.ts`.

## Source Of Truth

- Collection typings and names: `getCollections()`
- Index setup: `ensureMongoIndexes()`

If this document and code diverge, code is authoritative and this doc must be updated.

## Collection Map By Domain

### Auth / Session

- `users`
- `sessions`

### Astrology Core

- `birth_profiles`
- `natal_charts`
- `daily_transits`
- `ai_synergy_daily`
- `career_vibe_daily`
- `morning_briefing_daily`
- `career_insights`
- `full_natal_career_analysis`
- `discover_role_catalog`
- `discover_role_recommendations`
- `discover_role_current_jobs`
- `discover_role_shortlist_entries`
  - synced mobile shortlist rows with saved market/detail snapshots, including decision-support cards

### Jobs Parsing And Scoring

- `jobs_raw`
- `job_raw_artifacts`
- `jobs_parsed`
- `job_analyses`
- `job_scan_results`
- `job_usage_limits`
- `job_fetch_negative_cache`

### Billing

- `billing_subscriptions`
- `revenuecat_events`

### Notifications / Scheduler Outputs

- `push_notification_tokens`
- `burnout_alert_settings`
- `burnout_alert_jobs`
- `burnout_alert_events`
- `lunar_productivity_settings`
- `lunar_productivity_jobs`
- `interview_strategy_settings`
- `interview_strategy_slots`

### AI Platform / Telemetry

- `llm_gateway_telemetry`

### Market Data

- `market_occupation_insights`

## Index Contract (Critical)

### Auth / Session

- `users.appleSub` unique sparse
- `sessions.accessTokenHash` unique
- `sessions.refreshTokenHash` unique
- `sessions.userId + updatedAt`
- `sessions.refreshExpiresAt` TTL

### Astrology Core

- `birth_profiles.userId` unique
- `natal_charts.userId + profileHash` unique
- `career_insights.userId + profileHash + tier + promptVersion + model` unique
- `daily_transits.userId + profileHash + dateKey` unique
- `ai_synergy_daily.userId + profileHash + dateKey + algorithmVersion` unique
- `career_vibe_daily.userId + profileHash + dateKey + schemaVersion + tier + promptVersion + model` unique
- `morning_briefing_daily.userId + profileHash + dateKey + schemaVersion` unique
- `full_natal_career_analysis.userId + profileHash + promptVersion + model` unique
- `discover_role_catalog.slug` unique
- `discover_role_catalog.onetCode` unique partial (`string` only)
- `discover_role_recommendations.userId + profileHash + algorithmVersion` unique
- `discover_role_current_jobs.userId` unique
- `discover_role_current_jobs.updatedAt` descending
- `discover_role_shortlist_entries.userId + slug` unique
- `discover_role_shortlist_entries.userId + updatedAt` descending

### Jobs

- `jobs_raw.canonicalUrlHash` unique
- `jobs_raw.expiresAt` TTL sparse
- `job_raw_artifacts.canonicalUrlHash` unique
- `job_raw_artifacts.expiresAt` TTL
- `jobs_parsed.jobContentHash + parserVersion` unique
- `jobs_parsed.expiresAt` TTL sparse
- `job_analyses.userId + profileHash + jobContentHash + rubricVersion + modelVersion` unique
- `job_scan_results.userId + historyKey` unique
- `job_scan_results.userId + updatedAt` descending
- `job_usage_limits.userId` unique
- `job_fetch_negative_cache.canonicalUrlHash` unique
- `job_fetch_negative_cache.expiresAt` TTL

### Billing

- `billing_subscriptions.userId` unique
- `revenuecat_events.eventId` unique

### Notifications / Scheduling

- `push_notification_tokens.token` unique
- `burnout_alert_settings.userId` unique
- `burnout_alert_jobs.userId + dateKey` unique; each job stores the active `profileHash` so stale same-day timing can be ignored after profile edits
- `burnout_alert_events.userId + createdAt` descending
- `burnout_alert_events.type + createdAt` descending
- `burnout_alert_events.dateKey + type + createdAt` descending
- `burnout_alert_events.jobId + createdAt` sparse descending
- `lunar_productivity_settings.userId` unique
- `lunar_productivity_jobs.userId + dateKey` unique; each job stores the active `profileHash` so stale same-day timing can be ignored after profile edits
- `interview_strategy_settings.userId` unique
- `interview_strategy_slots.userId + slotId` unique

### AI Platform / Telemetry

- `llm_gateway_telemetry.createdAt` TTL
- `llm_gateway_telemetry.createdAt` descending
- `llm_gateway_telemetry.event + createdAt` descending
- `llm_gateway_telemetry.feature + createdAt` descending
- `llm_gateway_telemetry.promptVersion + createdAt` descending

### Market Data

- `market_occupation_insights.cacheKey` unique
- `market_occupation_insights.expiresAt` TTL
- `market_occupation_insights.occupation.onetCode + location`
- `market_occupation_insights.normalizedKeyword + normalizedLocation`

## Operational Notes

- All indexes are ensured on startup before server starts accepting traffic.
- TTL indexes are part of product behavior (session expiry, job cache windows, negative cache cooldown); changes are breaking behavior changes and must be documented.
- `discover_role_catalog` migration logic currently drops legacy `onetCode_1` index before recreating partial unique variant.
- `birth_profiles.currentJobTitle` and `birth_profiles.currentJobUpdatedAt` now hold the shared current-role personalization signal used across career surfaces; the field is excluded from `profileHash` and birth-profile edit-lock semantics.
- `discover_role_current_jobs` is now legacy compatibility storage for older clients and migration backfill into `birth_profiles.currentJobTitle`.
- `discover_role_shortlist_entries` stores the synced Discover Roles compare list in user-owned rows keyed by `(userId, slug)`.
- `llm_gateway_telemetry` retention is driven by `OPENAI_TELEMETRY_RETENTION_DAYS`.
- `market_occupation_insights` retention is driven by `MARKET_CACHE_TTL_DAYS`; cached rows store normalized provider facts, not raw provider payloads.
- `job_usage_limits` currently stores Lite/Full daily counters (`liteDateKey`, `liteDailyCount`, `fullDateKey`, `fullDailyCount`) while keeping legacy free/premium counter fields readable during migration. Legacy counters map to Full usage.
- `job_scan_results` stores saved scanner snapshots for cross-device reopen. Rows are keyed by normalized URL per user, with a screenshot placeholder key for manual screenshot scans.

## Related Files

- `src/db/mongo.ts`
- `src/apiServer.ts`
- `src/worker.ts`
- `src/services/llmTelemetry.ts`
- `src/services/marketData/occupationInsight.ts`
