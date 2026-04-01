# Mongo Collections And Indexes
**Status:** Active  
**Last synced:** 2026-04-01

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
- `morning_briefing_daily`
- `career_insights`
- `full_natal_career_analysis`
- `discover_role_catalog`
- `discover_role_recommendations`

### Jobs Parsing And Scoring

- `jobs_raw`
- `job_raw_artifacts`
- `jobs_parsed`
- `job_analyses`
- `job_usage_limits`
- `job_fetch_negative_cache`

### Billing

- `billing_subscriptions`
- `revenuecat_events`

### Notifications / Scheduler Outputs

- `push_notification_tokens`
- `burnout_alert_settings`
- `burnout_alert_jobs`
- `lunar_productivity_settings`
- `lunar_productivity_jobs`
- `interview_strategy_settings`
- `interview_strategy_slots`

### AI Platform / Telemetry

- `llm_gateway_telemetry`

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
- `morning_briefing_daily.userId + profileHash + dateKey + schemaVersion` unique
- `full_natal_career_analysis.userId + profileHash + promptVersion + model` unique
- `discover_role_catalog.slug` unique
- `discover_role_catalog.onetCode` unique partial (`string` only)
- `discover_role_recommendations.userId + profileHash + algorithmVersion` unique

### Jobs

- `jobs_raw.canonicalUrlHash` unique
- `jobs_raw.expiresAt` TTL sparse
- `job_raw_artifacts.canonicalUrlHash` unique
- `job_raw_artifacts.expiresAt` TTL
- `jobs_parsed.jobContentHash + parserVersion` unique
- `jobs_parsed.expiresAt` TTL sparse
- `job_analyses.userId + profileHash + jobContentHash + rubricVersion + modelVersion` unique
- `job_usage_limits.userId` unique
- `job_fetch_negative_cache.canonicalUrlHash` unique
- `job_fetch_negative_cache.expiresAt` TTL

### Billing

- `billing_subscriptions.userId` unique
- `revenuecat_events.eventId` unique

### Notifications / Scheduling

- `push_notification_tokens.token` unique
- `burnout_alert_settings.userId` unique
- `burnout_alert_jobs.userId + dateKey` unique
- `lunar_productivity_settings.userId` unique
- `lunar_productivity_jobs.userId + dateKey` unique
- `interview_strategy_settings.userId` unique
- `interview_strategy_slots.userId + slotId` unique

### AI Platform / Telemetry

- `llm_gateway_telemetry.createdAt` TTL
- `llm_gateway_telemetry.createdAt` descending
- `llm_gateway_telemetry.event + createdAt` descending
- `llm_gateway_telemetry.feature + createdAt` descending
- `llm_gateway_telemetry.promptVersion + createdAt` descending

## Operational Notes

- All indexes are ensured on startup before server starts accepting traffic.
- TTL indexes are part of product behavior (session expiry, job cache windows, negative cache cooldown); changes are breaking behavior changes and must be documented.
- `discover_role_catalog` migration logic currently drops legacy `onetCode_1` index before recreating partial unique variant.
- `llm_gateway_telemetry` retention is driven by `OPENAI_TELEMETRY_RETENTION_DAYS`.

## Related Files

- `src/db/mongo.ts`
- `src/apiServer.ts`
- `src/worker.ts`
- `src/services/llmTelemetry.ts`
