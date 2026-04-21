# Notifications And Billing Contracts
**Status:** Active  
**Last synced:** 2026-04-13

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

Current scheduler behavior:
- burnout timing is triggered only when `risk.score >= BURNOUT_ALERT_MIN_SCORE` and severity is not `none`
- `GET /burnout-plan` returns current-day timing only when alerts are enabled and the saved job matches the active birth-profile hash
- burnout plan/seen endpoints and the burnout scheduler build the required daily transit without waiting for AI synergy generation, because burnout risk uses only the transit document
- burnout scheduler estimates the local stress peak by scanning fixed local sample hours `[08:00, 10:00, 12:00, 14:00, 16:00, 18:00, 20:00]` and schedules before the highest stress window
- burnout scheduler does not start when global Expo push access is missing, so it does not create planned jobs that cannot be dispatched
- burnout scheduler and seen acknowledgement write durable `burnout_alert_events` records for planned/skipped/cancelled/sent/failed/seen outcomes to support QA and release debugging without changing the mobile API contract
- stale same-day burnout jobs from an earlier onboarding/profile edit are ignored for current plan status and cancelled before dispatch
- future birth-profile edit flows must write through `PUT /api/astrology/birth-profile` and then refresh dependent backend-derived outputs from the new `profileHash`; do not reuse client-local profile caches for burnout plan/push timing decisions
- opening the dashboard with an in-threshold burnout card calls `POST /burnout-seen` so a pending same-day push is cancelled once the guidance was already shown in-app
- shipped burnout pushes use action-oriented guidance copy rather than raw model diagnostics

### `POST /burnout-seen`

Purpose:
- acknowledge that the current in-threshold burnout insight was already surfaced in-app and suppress any same-day unsent burnout push.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Validation:
- body requires current-day `dateKey` in `YYYY-MM-DD`

Success:
- returns acknowledgement result with `acknowledged`, `reason`, `dateKey`, and resulting `timingStatus`
- if the matching push was still pending, current-day burnout job is marked cancelled and planner skips re-planning for that same `dateKey`
- acknowledgement writes the active birth-profile hash so scheduler suppression follows the data version the user actually saw

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
- `risk` (algorithm version, score, severity, `impactDirection`, lunar components/signals)
- `timing` (next planned time, status, scheduled date/severity)

Current scheduler behavior:
- lunar timing is triggered only on extreme score bands: `<= 25` (`supportive`) and `>= 80` (`disruptive`)
- `risk.severity` remains risk-oriented, so strongly supportive low-score days can still return `timing.status = planned` while `risk.severity = none`
- lunar plan/seen endpoints and the lunar scheduler build the required daily transit without waiting for AI synergy generation, because lunar productivity risk uses only the transit document
- lunar scheduler does not start when global Expo push access is missing, so it does not create planned jobs that cannot be dispatched
- shipped lunar pushes use direction-aware, action-oriented copy rather than raw risk diagnostics
- lunar timing state is scoped to the active birth-profile hash; stale same-day jobs from an earlier onboarding/profile edit are ignored for current plan status
- future birth-profile edit flows must write through `PUT /api/astrology/birth-profile` and then refresh dependent backend-derived outputs from the new `profileHash`; do not reuse client-local profile caches for lunar plan/push timing decisions

### `POST /lunar-productivity-seen`

Purpose:
- acknowledge that the current in-range lunar insight was already surfaced in-app and suppress any same-day unsent lunar push.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Validation:
- body requires current-day `dateKey` in `YYYY-MM-DD`

Success:
- returns acknowledgement result with `acknowledged`, `reason`, `dateKey`, `impactDirection`, and resulting `timingStatus`
- if the matching push was still pending, current-day lunar job is marked cancelled and planner skips re-planning for that same `dateKey`
- acknowledgement writes the active birth-profile hash so scheduler suppression follows the data version the user actually saw

### `PUT /interview-strategy-settings`

Purpose:
- persist interview strategy generation settings.

Auth:
- required (`401`)
- premium required (`403`, `{ code: "premium_required" }`)

Validation:
- zod payload constraints
- `enabled` and `timezoneIana` are the active controls.
- legacy workday/duration/weekday fields remain accepted for older clients, but the planner now uses a fixed backend range policy.
- timezone/workday/quiet-hours guard rails (`400` on invalid legacy values)

Success:
- returns `{ settings }`
- does not generate slots; clients should call `GET /interview-strategy-plan` after saving settings.
- saving `enabled=false` preserves future server windows; mobile removes device-local calendar events separately.

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
- missing birth profile or natal chart -> `404`
- planning failures -> `502`

Current planning behavior:
- server requires the active natal chart and blends transit-to-natal interview signals with daily career momentum and a neutral AI-synergy prior.
- generated calendar windows are sparse: up to 4-5 strongest windows per 30-day horizon, with one 1-3 hour range per selected day.
- slots below `INTERVIEW_STRATEGY_MIN_SCORE` are not normally backfilled; the default threshold is `68`.
- first-release safety heuristic: when the normal threshold returns zero windows, selection can temporarily use a safety floor within that generation to one best window at or above `62`; this safety floor is not persisted and the next rolling generation starts from the normal threshold again.
- each returned slot includes `explanation`, `explanationSource`, and `calendarNote`; mobile writes the short note into calendar event notes and creates the event with free availability.
- API-triggered generation returns deterministic explanations immediately; optional provider polish updates stored slots in the background and marks only those replacements as `explanationSource=llm`.
- plan generation/refill deletes expired past slots for the user while preserving future slots when the feature is manually disabled.
- first-release auto-enable is mobile-driven only when returned settings are `source: "default"`; saved `enabled=false` is treated as manual opt-out.

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

## Current Burnout Delivery Status

- Burnout settings, current-day plan lookup, planner, push dispatch, and in-app seen acknowledgement are enabled.
- `GET /burnout-plan` returns timing from the current local `dateKey` only when alerts are enabled and timing belongs to the active `profileHash`; otherwise timing falls back to `not_scheduled`.

## Current Lunar Delivery Status

- Lunar productivity settings, current-day plan lookup, planner, and push dispatch are enabled.
- `GET /lunar-productivity-plan` returns timing from the current local `dateKey` only when alerts are enabled; otherwise timing falls back to `not_scheduled`.

## Source Files

- `src/routes/notifications.ts`
- `src/services/burnoutAlerts.ts`
- `src/services/lunarProductivity.ts`
- `src/services/interviewStrategy.ts`
- `src/routes/billing.ts`
- `src/services/billingSync.ts`
