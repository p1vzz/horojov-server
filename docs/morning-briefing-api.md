# Morning Briefing API
**Version:** 0.2  
**Status:** Implemented (backend v2)  
**Owner:** Backend API

## Purpose
Provide a compact, widget-ready morning payload for premium users without duplicating heavy chart logic in mobile clients.

## Endpoint: Morning Briefing
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
  "schemaVersion": "morning-briefing-v2",
  "headline": "Mercury focus window",
  "summary": "Good day for decision-heavy tasks and async collaboration.",
  "metrics": {
    "energy": 71,
    "focus": 78,
    "luck": 63,
    "aiSynergy": 74
  },
  "modeLabel": "Execution Mode",
  "plan": {
    "headline": "Mercury focus window",
    "summary": "Good day for decision-heavy tasks and async collaboration.",
    "primaryAction": "Use the strongest window for one decision-heavy deliverable.",
    "peakWindow": "10AM-12PM",
    "riskGuardrail": "Keep one review checkpoint before external sharing."
  },
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

## Endpoint: Career Vibe Plan
`GET /api/astrology/career-vibe-plan`

Auth:
- Required (`Authorization: Bearer <token>`).
- Premium is not required. The response includes `tier` from the authenticated user.

Query params:
- `refresh` (`true|false`, optional, default `false`) - bypass cache for this request.

## Career Vibe Plan Response 200 (Example)
```json
{
  "dateKey": "2026-03-20",
  "cached": false,
  "schemaVersion": "career-vibe-plan-v1",
  "tier": "premium",
  "narrativeSource": "llm",
  "model": "gpt-4o-mini",
  "promptVersion": "v1",
  "generatedAt": "2026-03-20T06:10:04.120Z",
  "staleAfter": "2026-03-21T00:00:00.000Z",
  "modeLabel": "Execution Mode",
  "metrics": {
    "energy": 71,
    "focus": 78,
    "luck": 63,
    "opportunity": 63,
    "aiSynergy": 74
  },
  "plan": {
    "headline": "Mercury focus window",
    "summary": "Use the day for one focused delivery loop, then close with a review checkpoint.",
    "primaryAction": "Finish one decision-heavy deliverable before opening new threads.",
    "bestFor": ["Deep work", "Prioritization", "AI-assisted drafting"],
    "avoid": ["Starting broad parallel work", "Skipping final review"],
    "peakWindow": "10AM-12PM",
    "focusStrategy": "Keep the first work block narrow and define done before starting.",
    "communicationStrategy": "Batch outbound messages after the primary work block.",
    "aiWorkStrategy": "Use AI for draft structure and edge-case review, not final judgment.",
    "riskGuardrail": "Hold one human review checkpoint before external sharing."
  },
  "explanation": {
    "drivers": ["Focus quality supports structured delivery."],
    "cautions": ["Avoid rapid context switching."],
    "metricNotes": ["Energy 71% sets the capacity for execution and pace."]
  },
  "sources": {
    "dailyTransitDateKey": "2026-03-20",
    "aiSynergyDateKey": "2026-03-20",
    "dailyVibeAlgorithmVersion": "daily-vibe-v2",
    "aiSynergyAlgorithmVersion": "ai-synergy-v2"
  }
}
```

Career Vibe Plan errors:
- `401 Unauthorized`
  - `{ "error": "Unauthorized" }`
- `400 Bad Request` for invalid query parameters
  - `{ "error": "Invalid query parameters", "details": { ... } }`
- `404 Not Found` when required profile/chart data is missing
  - `{ "error": "Birth profile not found. Complete onboarding first." }`
- `502 Bad Gateway` when plan generation fails
  - `{ "error": "Unable to build career vibe plan" }`

## Data Derivation Rules
- Reuse existing outputs from:
  - `getOrCreateDailyTransitForUser(...)`
- cached AI synergy history when present
- `career-vibe-plan` builds deterministic metrics from daily transit plus cached AI synergy when present; otherwise it derives the AI metric from transit metrics.
- Premium `career-vibe-plan` may request provider narrative only after deterministic metrics and peak window are built.
- For `refresh=false`, provider narrative is not awaited by the endpoint; new same-day payloads can remain `plan=null` with `narrativeStatus=pending` while background generation runs.
- Provider output is schema-normalized and can only fill narrative plan text. Invalid output sets `plan=null` plus a typed failure status; no template copy is returned as a successful plan.
- Do not introduce separate astrology computation paths for widget payload.
- Keep payload deterministic per user + date key + algorithm version.

## Caching Strategy
- Daily cache key: `userId + profileHash + dateKey + schemaVersion`.
- Return `cached: true` when same day payload already exists and `refresh=false`.
- Keep history in a dedicated collection for troubleshooting and future trend features.

Implemented collections:
- `morning_briefing_daily`
- `career_vibe_daily`

Implemented indexes:
- unique: `(userId, profileHash, dateKey, schemaVersion)`
- helper: `(userId, dateKey desc)`
- `career_vibe_daily` unique: `(userId, profileHash, dateKey, schemaVersion, tier, promptVersion)`
- `career_vibe_daily` helper: `(userId, dateKey desc)`

## Compatibility Notes
- Mobile widget should treat unknown fields as optional.
- Any breaking field rename requires `schemaVersion` bump.
- Existing `/api/astrology/daily-transit` keeps the same response shape. By default it returns cached AI Synergy only; `includeAiSynergy=true` can request synchronous AI Synergy generation.
