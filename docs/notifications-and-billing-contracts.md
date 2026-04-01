# Notifications And Billing Contracts
**Status:** Active  
**Last synced:** 2026-03-30

## Goal

Document stable backend contract behavior for notifications and billing endpoints consumed by mobile clients.

## Notifications API (`/api/notifications`)

### `PUT /push-token`

Purpose:
- upsert Expo push token and mark it active for a user.

Auth:
- required (`401` on missing/invalid session).

Validation:
- request payload validated with zod (`token`, `platform`, optional `appVersion`).
- invalid payload returns `400` with `details`.

Success:
- returns normalized token metadata:
  - `platform`
  - `active`
  - `updatedAt`
  - `lastSeenAt`

### `PUT /burnout-settings`

Purpose:
- persist burnout notification preferences.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Validation:
- invalid payload or timezone/workday/quiet-hours constraints -> `400`.

Success:
- returns `{ settings }` (effective saved settings).

### `GET /burnout-plan`

Purpose:
- return current burnout risk snapshot plus scheduling status.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Error behavior:
- `404` when birth profile is missing
- `502` for upstream/transit build failures

Success payload sections:
- `risk` (algorithm version, score, severity, components, signals)
- `timing` (next planned time, status, scheduled date/severity)

### `PUT /lunar-productivity-settings`

Purpose:
- persist lunar productivity notification preferences.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Validation:
- invalid payload or timezone/workday/quiet-hours constraints -> `400`.

Success:
- returns `{ settings }` (effective saved settings).

### `GET /lunar-productivity-plan`

Purpose:
- return current lunar productivity risk snapshot plus scheduling status.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Error behavior:
- `404` when birth profile is missing
- `502` for upstream/transit build failures

Success payload sections:
- `risk` (algorithm version, score, severity, lunar components/signals)
- `timing` (next planned time, status, scheduled date/severity)

### `PUT /interview-strategy-settings`

Purpose:
- persist interview strategy generation settings.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Validation:
- zod payload constraints
- timezone/workday/quiet-hours guard rails (`400` on invalid values)

Success:
- returns `{ settings }`
- may trigger non-blocking refill path when enabled + autofill confirmed.

### `GET /interview-strategy-plan`

Purpose:
- return server-generated slot plan.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Query:
- `refresh=true|false` (default behavior uses refill if needed).

Error behavior:
- invalid query -> `400`
- planning failures -> `502`

## Billing API (`/api/billing`)

### `GET /subscription`

Purpose:
- return current public user snapshot + billing projection.

Auth:
- required (`401`)

### `POST /revenuecat/sync`

Purpose:
- manual on-demand sync of RevenueCat entitlement state for authenticated user.

Auth:
- required (`401`)

Error behavior:
- `500` when RevenueCat is not configured
- `502` for sync failures

### `POST /revenuecat/webhook`

Purpose:
- process RevenueCat server-to-server events.

Auth:
- bearer token in header must match `REVENUECAT_WEBHOOK_AUTH_TOKEN`.

Error behavior:
- `500` when webhook token is not configured
- `401` on invalid webhook auth header
- `400` on invalid payload
- `500` when processing fails after acceptance

Idempotency:
- `eventId` is persisted in `revenue_cat_events` and duplicates are treated as non-fatal.

## Known Gap (Current)

- Lunar productivity scheduler push-dispatch pipeline is not yet enabled.
- Current lunar API returns deterministic risk/timing contract using latest persisted lunar job (or `not_scheduled` when absent).

## Source Files

- `src/routes/notifications.ts`
- `src/services/burnoutAlerts.ts`
- `src/services/lunarProductivity.ts`
- `src/services/interviewStrategy.ts`
- `src/routes/billing.ts`
- `src/services/billingSync.ts`
