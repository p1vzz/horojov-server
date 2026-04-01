# Backend API And Runtime Map
**Status:** Active  
**Last synced:** 2026-03-30

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
- `POST /natal-chart`
- `GET /daily-transit`
- `GET /ai-synergy/history`
- `GET /morning-briefing` (premium)
- `GET /full-natal-analysis` (premium)
- `POST /full-natal-analysis/regenerate` (premium)
- `GET /career-insights`
- `GET /discover-roles`

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
- `PUT /lunar-productivity-settings` (premium)
- `GET /lunar-productivity-plan` (premium)
- `PUT /interview-strategy-settings` (premium)
- `GET /interview-strategy-plan` (premium)

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

- Lunar productivity scheduler/push dispatch pipeline is not enabled yet.
- API routes for lunar settings/plan are now implemented and can be consumed by mobile.

## Related Files

- `src/server.ts`
- `src/apiServer.ts`
- `src/worker.ts`
- `src/runtime/processLifecycle.ts`
- `src/app.ts`
- `src/routes/*.ts`
- `src/services/astrology/*Routes.ts`
- `src/db/mongo.ts`
