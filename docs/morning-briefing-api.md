# Morning Briefing API
**Version:** 0.1  
**Status:** Implemented (backend v1)  
**Owner:** Backend API

## Purpose
Provide a compact, widget-ready morning payload for premium users without duplicating heavy chart logic in mobile clients.

## Endpoint
`GET /api/astrology/morning-briefing`

Auth:
- Required (`Authorization: Bearer <token>`).

Query params:
- `refresh` (`true|false`, optional, default `false`) - bypass cache for this request.

## Response 200 (Example)
```json
{
  "dateKey": "2026-03-20",
  "cached": true,
  "generatedAt": "2026-03-20T06:10:04.120Z",
  "schemaVersion": "morning-briefing-v1",
  "headline": "Mercury focus window",
  "summary": "Good day for decision-heavy tasks and async collaboration.",
  "metrics": {
    "energy": 71,
    "focus": 78,
    "luck": 63,
    "aiSynergy": 74
  },
  "modeLabel": "Execution Mode",
  "staleAfter": "2026-03-21T05:00:00.000Z",
  "sources": {
    "dailyTransitDateKey": "2026-03-20",
    "aiSynergyDateKey": "2026-03-20"
  }
}
```

## Error Contracts
- `401 Unauthorized`
  - `{ "error": "Unauthorized" }`
- `403 Forbidden` for non-premium users
  - `{ "error": "Premium required", "code": "premium_required" }`
- `404 Not Found` when required profile/chart data is missing
  - `{ "error": "Birth profile not found. Complete onboarding first." }`
- `502 Bad Gateway` when transit generation fails
  - `{ "error": "Unable to build morning briefing" }`

## Data Derivation Rules
- Reuse existing outputs from:
  - `getOrCreateDailyTransitForUser(...)`
  - AI synergy generation/history logic
- Do not introduce separate astrology computation paths for widget payload.
- Keep payload deterministic per user + date key + algorithm version.

## Caching Strategy
- Daily cache key: `userId + profileHash + dateKey + schemaVersion`.
- Return `cached: true` when same day payload already exists and `refresh=false`.
- Keep history in a dedicated collection for troubleshooting and future trend features.

Proposed collection:
- `morning_briefing_daily`

Proposed indexes:
- unique: `(userId, profileHash, dateKey, schemaVersion)`
- helper: `(userId, dateKey desc)`

## Compatibility Notes
- Mobile widget should treat unknown fields as optional.
- Any breaking field rename requires `schemaVersion` bump.
- Existing `/api/astrology/daily-transit` remains unchanged.
