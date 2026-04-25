# Backend API And Runtime Map
**Status:** Active  
**Last synced:** 2026-04-25

## Goal

Provide one current map of backend API surface and runtime orchestration (startup, schedulers, shutdown).

## App Composition

- Primary API entry: `src/apiServer.ts`
- Primary worker entry: `src/worker.ts`
- Legacy combined entry: `src/server.ts`
- App builder: `src/app.ts`
- Fastify route groups:
  - `/api/auth`
  - `/api/cities`
  - `/api/astrology`
  - `/api/jobs`
  - `/api/market`
  - `/api/public/market`
  - `/api/billing`
  - `/api/notifications`

## Public Route Surface (Current)

### Health

- `GET /health`

### Auth (`/api/auth`)

- `POST /anonymous`
- `POST /refresh`
- `GET /me`
- `POST /apple-link`
- `POST /logout`

### Cities (`/api/cities`)

- `GET /search`

### Astrology (`/api/astrology`)

- `GET /birth-profile`
- `PUT /birth-profile`
  - in production when `BIRTH_PROFILE_EDIT_LOCKS_ENABLED` is effectively true, profile-changing updates are rate locked per user: first successful edit locks the next edit for 1 day, then 2/4/8/16/30 days on later successful edits; blocked edits return `429` with `code=birth_profile_edit_locked` and `editLock`
  - outside production, birth-profile edit locks are effectively disabled even if the env flag is set
  - optional `currentJobTitle` now lives on the same profile payload for app-wide personalization, but it stays outside `profileHash` and does not trigger birth-profile edit locks by itself
- `POST /natal-chart`
- `GET /daily-transit`
  - query: `includeAiSynergy=true|false`; default uses cached AI Synergy only and does not generate an AI narrative synchronously
- `GET /ai-synergy/history`
- `GET /morning-briefing` (premium)
- `GET /full-natal-analysis` (premium)
- `GET /full-natal-analysis/progress` (premium)
- `GET /career-insights`
- `GET /discover-roles`
  - query: `query`, `limit`, `searchLimit`, `refresh`, `rankingMode=fit|opportunity`
  - optional deferred scoring for mobile search: `deferSearchScores=true` returns search rows without scores; `scoreSlug=<role-slug>` returns the deterministic score for one selected row
  - response includes optional `context.currentJob`; recommendations/search rows include optional `detail` (`whyFit`, `realityCheck`, `entryBarrier`, `transitionMap`, `bestAlternative`) plus optional market enrichment and `opportunityScore`
  - market enrichment failures degrade to fit-only role cards; role-detail sections do not depend on market success
- `GET /discover-roles/current-job`
- `PUT /discover-roles/current-job`
- `DELETE /discover-roles/current-job`
  - compatibility shim over the shared birth-profile `currentJobTitle` field, with best-effort matching to the role catalog
- `GET /discover-roles/shortlist`
- `PUT /discover-roles/shortlist/:slug`
- `DELETE /discover-roles/shortlist/:slug`
  - shortlist rows sync the saved mobile compare list across devices; payload mirrors the mobile shortlist card shape (`role`, `domain`, score labels, tags, market snapshot, `detail`, `savedAt`)

### Jobs (`/api/jobs`)

- `GET /limits`
  - returns legacy Full-compatible `limit` plus `limits.lite` and `limits.full`
- `GET /metrics`
- `GET /alerts`
- `POST /preflight`
  - returns cache state, `recommendedScanDepth`, and Lite/Full usage snapshot
- `POST /analyze`
  - accepts `scanDepth=auto|lite|full`; `auto` prefers Full then falls back to Lite
  - returns `scanDepth`, `requestedScanDepth`, `usage.depth`, `usage.limits`, optional `market`, and nullable `job.salaryText`
- `POST /analyze-screenshots`
  - Full-only for now; returns `scanDepth=full` and market enrichment when available

### Market (`/api/market`)

- `GET /occupation-insight`
  - query: `keyword` required, `location` default `US`, `refresh=true|false`
  - requires current app auth session
  - returns normalized CareerOneStop/O*NET occupation facts, salary range, outlook, skills, labels, and source attribution
  - raw provider credentials remain server-side; response includes attribution metadata and `logoRequired` flags

### Public Market (`/api/public/market`)

- `GET /occupation-insight`
  - query: `keyword` required, `location` default `US`
  - no auth; used by the public compliance surface in `../horojob-landing`
  - mirrors the normalized occupation insight payload from `/api/market/occupation-insight`
  - forces cache-safe behavior (`refresh=false`) and keeps provider credentials server-side

### Billing (`/api/billing`)

- `GET /subscription`
- `POST /revenuecat/sync`
- `POST /revenuecat/webhook`

### Notifications (`/api/notifications`)

- `PUT /push-token`
- `PUT /burnout-settings` (premium)
- `GET /burnout-plan` (premium)
- `POST /burnout-seen` (premium)
- `PUT /lunar-productivity-settings` (premium)
- `GET /lunar-productivity-plan` (premium)
- `POST /lunar-productivity-seen` (premium)
- `PUT /interview-strategy-settings` (premium)
- `GET /interview-strategy-plan` (premium)
  - API-triggered rebuild/refill returns deterministic slots first; optional LLM explanation polish runs in the background

## Runtime Sequence

### API process (`src/apiServer.ts`)

1. Parse env and build app.
2. Ensure Mongo indexes (`ensureMongoIndexes()`).
3. Start HTTP server.
4. On SIGINT/SIGTERM:
   - close Fastify
   - close browser fallback
   - close cache store
   - close Mongo connection

### Worker process (`src/worker.ts`)

1. Parse env and build app.
2. Validate worker runtime config.
3. Ensure Mongo indexes (`ensureMongoIndexes()`).
4. Start schedulers:
   - daily transit scheduler
   - job metrics alert scheduler
   - burnout alert scheduler
   - lunar productivity scheduler
   - interview strategy scheduler
5. On SIGINT/SIGTERM:
   - stop schedulers
   - close Fastify logger/app instance
   - close browser fallback
   - close cache store
   - close Mongo connection

### Legacy combined process (`src/server.ts`)

- Starts both HTTP server and schedulers in one runtime.
- Kept for local development and operational fallback only.

## Persistence Contract Anchors

- Collection typing and index source of truth: `src/db/mongo.ts`
- Any query-shape or TTL change must be reviewed with `ensureMongoIndexes()`.

## Known Scope Boundary

- Legacy combined runtime remains available for local development and operational fallback.
- Mobile dashboard/settings UX for lunar scheduling status remains a separate client-side concern.

## Related Files

- `src/server.ts`
- `src/apiServer.ts`
- `src/worker.ts`
- `src/runtime/processLifecycle.ts`
- `src/app.ts`
- `src/routes/*.ts`
- `src/services/astrology/*Routes.ts`
- `src/services/marketData/*`
- `src/db/mongo.ts`
