# Jobs API Contract
**Status:** Active  
**Last synced:** 2026-04-24

## Goal

Document stable server-side contract behavior for `/api/jobs` endpoints: auth, validation, cache/limit semantics, and error mapping.

## Route Surface

Base prefix: `/api/jobs`

- `GET /limits`
- `GET /history?limit=8`
- `GET /metrics?windowHours=24`
- `GET /alerts?windowHours=24`
- `POST /history/import`
- `POST /preflight`
- `POST /analyze`
- `POST /analyze-screenshots`

All routes require Bearer auth (`401 { error: "Unauthorized" }` on missing/invalid session).

## Shared Input Rules

- `windowHours` query (`metrics`/`alerts`): integer `1..336`, default `24`.
- `history` query: `limit` integer `1..20`, default `8`.
- `preflight` body: `{ url: string(8..2048) }`
- `analyze` body: `{ url: string(8..2048), regenerate?: boolean, scanDepth?: "auto" | "lite" | "full" }`
- `history/import` body:
  - `entries`: array `1..16`
  - each item: `{ url: string(1..2048), analysis: object, meta: { source: string, cached: boolean, provider: string | null }, savedAt?: string }`
- `analyze-screenshots` body:
  - `screenshots`: array `1..JOB_SCREENSHOT_MAX_IMAGES` (default `6`)
  - each item: `{ dataUrl: string(64..12_000_000) }`
  - `regenerate` is accepted but not used in current screenshot flow.

Invalid schema => `400` with `details`.

## URL Validation Contract (`preflight` + `analyze`)

Validation is based on `validateAndCanonicalizeJobUrl`:

- `invalid_url` => `400`
- `unsupported_protocol` => `400` (only `https://`)
- `unsupported_source` => `422`
- `unsupported_path` => `422`

LinkedIn canonicalization accepts concrete job detail paths and LinkedIn jobs
surfaces carrying a numeric `currentJobId`, then canonicalizes both to
`https://linkedin.com/jobs/view/<id>`. LinkedIn jobs collection/search pages
without a concrete job id remain `unsupported_path`.

Response shape on URL validation error:

```json
{
  "error": "string",
  "code": "invalid_url | unsupported_protocol | unsupported_source | unsupported_path"
}
```

## `GET /limits`

Returns user plan, legacy Full-compatible usage gate, and the current Lite/Full usage snapshot:

```json
{
  "plan": "free | premium",
  "limit": {
    "plan": "free | premium",
    "depth": "full",
    "period": "daily_utc",
    "limit": 1,
    "used": 0,
    "remaining": 1,
    "nextAvailableAt": "ISO|null",
    "canProceed": true
  },
  "limits": {
    "plan": "free | premium",
    "lite": {
      "plan": "free | premium",
      "depth": "lite",
      "period": "daily_utc",
      "limit": 30,
      "used": 0,
      "remaining": 30,
      "nextAvailableAt": "ISO|null",
      "canProceed": true
    },
    "full": {
      "plan": "free | premium",
      "depth": "full",
      "period": "daily_utc",
      "limit": 1,
      "used": 0,
      "remaining": 1,
      "nextAvailableAt": "ISO|null",
      "canProceed": true
    }
  }
}
```

## `GET /metrics` and `GET /alerts`

- `metrics` returns aggregated parser quality report by source.
- `alerts` runs threshold evaluation over the same metrics window.
- Both endpoints are technical surfaces gated by `JOB_METRICS_ENDPOINTS_ENABLED`.
  The default is enabled outside production and disabled in production. Disabled
  endpoints return `404 { "error": "Not found" }`.
- Production startup rejects `JOB_METRICS_ENDPOINTS_ENABLED=true`.
- Invalid query => `400` (`Invalid metrics query` / `Invalid alerts query`).

## `GET /history`

Returns the user's saved scanner history in reverse chronological order:

```json
[
  {
    "url": "https://linkedin.com/jobs/view/123",
    "analysis": {
      "analysisId": "analysis-id",
      "status": "done"
    },
    "meta": {
      "source": "linkedin",
      "cached": false,
      "provider": "http_fetch"
    },
    "savedAt": "2026-04-24T08:00:00.000Z"
  }
]
```

Contract notes:

- response rows are the exact saved scanner snapshots used for reopen; the server does not recompute history on read.
- history is de-duped by per-user history key (normalized URL, or a screenshot placeholder key when no URL exists).
- invalid query => `400 { "error": "Invalid history query" }`.

## `POST /history/import`

Purpose: one-way mobile backfill of legacy AsyncStorage history into server-owned history.

Success payload:

```json
{
  "importedCount": 2
}
```

Contract notes:

- import is authenticated and idempotent per user/history key.
- older imported rows do not overwrite newer server snapshots for the same key.
- invalid body => `400 { "error": "Invalid history import payload" }`.

## `POST /preflight`

Purpose: cheap URL normalization + cache matrix + usage state before heavy parsing.

Success payload includes:

- canonical URL identity: `source`, `canonicalUrl`, `canonicalUrlHash`, `sourceJobId`, `routing`
- `nextStage` (`done | running_scoring | normalizing_job_payload | cooldown | fetching_http_fetch`)
- `cache` object:
  - `raw` hit + timestamp
  - `parsed` hit + parserVersion + timestamp
  - `analysis` hit + rubric/model versions + timestamp
  - `negative` hit + status + `retryAt`
- `limit` (same shape as `/limits`)
- `limits` (`lite` and `full` usage snapshot)
- `recommendedScanDepth` (`full` if available, otherwise `lite` when Lite remains)
- `versions` (`parserVersion`, `rubricVersion`, `modelVersion`)

## `POST /analyze`

Purpose: end-to-end fetch/normalize/parse/score with layered caching.

Flow summary:

1. Auth + payload + URL validation.
2. Resolve `scanDepth`:
   - default `auto` prefers Full when Full quota remains.
   - if Full quota is exhausted and Lite remains, `auto` runs Lite.
   - explicit `full` returns `429 code=usage_limit_reached` when Full is exhausted.
3. Reuse valid `jobs_raw` cache when available.
4. If no raw cache:
   - enforce selected scan depth usage limit (`429 code=usage_limit_reached` when blocked)
   - fetch via provider fallback
   - persist raw payload and optional raw HTML artifact.
5. Reuse or build parsed features cache (`jobs_parsed`).
6. For Lite:
   - no birth profile or natal chart is required.
   - enrich normalized job with market data when available.
   - increment Lite usage after successful response construction.
7. For Full:
   - require birth profile and natal chart (`404` if missing).
   - reuse per-user analysis cache (`job_analyses`) unless `regenerate=true`.
   - build deterministic analysis, enrich with market data, persist, and increment Full usage.
   - cached Full analysis reopens without incrementing usage.

Success payload (high-level):

- `analysisId`, `status`, `scanDepth`, `requestedScanDepth`, `providerUsed`, `providerAttempts`
- `cached` + `cache.{raw,parsed,analysis}`
- `usage.{plan,depth,incremented,limit,limits}`
- `versions`
- `scores`, `breakdown`, `jobSummary`, `tags`, `descriptors`
- `market` (`null` when market enrichment is unavailable)
- normalized `job` preview:
  - `title`
  - `company`
  - `location`
  - `salaryText` (`string | null`; posted salary text extracted from source payload when available)
  - `employmentType`
  - `source`

Lite responses keep `scores` as zero values and `breakdown` as an empty array for compatibility. Mobile renders Lite-specific market content and locked Full panels instead of treating those compatibility fields as real scores.

### Analyze Error Matrix (non-validation)

- `401` unauthorized
- `404` birth profile or natal chart missing
- `429` usage limit reached (`code: "usage_limit_reached"`, with `scanDepth`, `limit`, and `limits`)
- `404` negative cache `not_found`
- `422` negative cache `login_wall`
- `429` negative cache `blocked`
- `502` provider/persistence failures (`code` may include provider failure code)

Negative cache responses include `retryAt`.

## `POST /analyze-screenshots`

Purpose: parse vacancy from screenshot data URLs (vision model), then score with same deterministic rubric.

Contract specifics:

- still requires birth profile + natal chart (`404` if missing).
- enforces Full usage limits before parse.
- increments Full usage after successful screenshot parse/score.
- currently returns synthetic `analysisId` and does not persist `job_analyses`.
- successful URL and screenshot analyses also upsert `job_scan_results` so saved scans can sync across devices.
- returns `scanDepth: "full"`, `requestedScanDepth: "full"`, `usage.depth: "full"`, `usage.limits`, and `market`.
- returns `job.salaryText: null` for screenshot analysis until the screenshot parser explicitly extracts posted compensation.
- success requires visible role title, company name, and substantial job description/responsibilities.
- location, seniority, and employment type are useful if visible but are not the user-facing minimum.

Error mapping:

- `422 code=screenshot_not_vacancy`
- `422 code=screenshot_incomplete_info` (+ core `missingFields`: `title`, `company`, `description`)
- `400` other parser validation errors
- `502 code=screenshot_parse_failed` on unexpected parse failure
- `429 code=usage_limit_reached` on limit block

## Cache Semantics (Current)

- `jobs_raw` TTL: `JOB_CACHE_TTL_DAYS`
- `jobs_parsed` TTL: `JOB_CACHE_TTL_DAYS`
- `job_raw_artifacts` TTL: `JOB_SCRAPER_RAW_HTML_RETENTION_DAYS`
- `job_fetch_negative_cache` TTL by status:
  - blocked: `JOB_SCRAPER_NEGATIVE_TTL_BLOCKED_SECONDS`
  - login_wall: `JOB_SCRAPER_NEGATIVE_TTL_LOGIN_WALL_SECONDS`
  - not_found: `JOB_SCRAPER_NEGATIVE_TTL_NOT_FOUND_SECONDS`

## Usage Limit Semantics

- `free`: 30 Lite checks per UTC day and 1 Full analysis per UTC day.
- `premium`: 30 Lite checks per UTC day and 10 Full analyses per UTC day.
- successful Lite increments Lite count; successful Full increments Full count.
- cached Full analysis reopen does not increment Full count.
- screenshot analysis is Full-only and increments Full count after success.
- legacy single-counter fields remain readable during migration and map to Full usage.
- outside production, `JOB_USAGE_LIMITS_ENABLED=false` returns effectively unlimited sentinel values.
- production startup rejects `JOB_USAGE_LIMITS_ENABLED=false` and `DEV_FORCE_PREMIUM_FOR_ALL_USERS=true`.

## Source Files

- `src/routes/jobs.handlers.ts`
- `src/services/jobs/*.ts`
- `src/services/jobUsageLimits.ts`
- `src/services/jobNegativeCache.ts`
- `src/services/jobUrl.ts`
- `src/services/jobCachePolicy.ts`
