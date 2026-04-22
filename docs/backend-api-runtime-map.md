# Backend API And Runtime Map
**Status:** Active  
**Last synced:** 2026-04-12

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
- `POST /natal-chart`
- `GET /daily-transit`
  - query: `includeAiSynergy=true|false`; default uses cached AI Synergy only and does not generate an AI narrative synchronously
- `GET /ai-synergy/history`
- `GET /morning-briefing` (premium)
- `GET /full-natal-analysis` (premium)
- `GET /full-natal-analysis/progress` (premium)
- `GET /career-insights`
- `GET /discover-roles`
  - query: `query`, `limit`, `searchLimit`, `refresh`
  - optional deferred scoring for mobile search: `deferSearchScores=true` returns search rows without scores; `scoreSlug=<role-slug>` returns the deterministic score for one selected row

### Jobs (`/api/jobs`)

- `GET /limits`
- `GET /metrics`
- `GET /alerts`
- `POST /preflight`
- `POST /analyze`
- `POST /analyze-screenshots`

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
- `src/db/mongo.ts`
