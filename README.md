# HoroJob Server

REST backend for HoroJob.

## Run

1. Install dependencies:
   - `npm install`
   - `npx playwright install chromium`
2. Copy env template:
   - `copy .env.example .env`
   - set `MONGO_URI` (or `MONGODB_URI`), Astrology credentials, and `OPENAI_API_KEY`
   - set `EXPO_PUSH_ACCESS_TOKEN` (or reuse existing `EXPO_TOKEN`) for burnout push delivery
   - job scraping MVP mode is HTTP-first and browser-fallback (`JOB_SCRAPER_HTTP_FIRST=true`)
   - source behavior is controlled by `JOB_SCRAPER_*` policy variables
   - usage limits can be disabled in local/dev with `JOB_USAGE_LIMITS_ENABLED=false`
   - premium can be forced for all local users with `DEV_FORCE_PREMIUM_FOR_ALL_USERS=true` (default in development)
   - raw HTML snapshots are stored separately with retention via `JOB_SCRAPER_RAW_HTML_RETENTION_DAYS`
   - alerts scheduler thresholds/intervals are configured via `JOB_METRICS_ALERT_*`
   - burnout scheduler thresholds/intervals are configured via `BURNOUT_ALERT_*`
   - interview strategy scheduler thresholds/intervals are configured via `INTERVIEW_STRATEGY_*`
  - optional local QA override: `BURNOUT_ALERT_FORCE_SEVERITY=warn|high|critical`
  - shared OpenAI retry and telemetry behavior is configured via `OPENAI_MAX_RETRIES`, `OPENAI_RETRY_*`, and `OPENAI_TELEMETRY_*`
3. Start dev server:
   - API only: `npm run dev`
   - worker only: `npm run dev:worker`
   - legacy combined runtime: `npm run dev:all`

Quality gates:
- `npm run check`
  - includes app typecheck and `scripts/tsconfig.json` validation
- `npm run lint`
- `npm test`
- `npm run verify`

Production-style runtime split:
- API process: `npm run start`
- worker process: `npm run start:worker`
- legacy combined runtime: `npm run start:all`

Worker runtime safety:
- in `production`, worker startup requires:
  - `REDIS_ENABLED=true`
  - valid `REDIS_URL`
  - `SCHEDULER_LOCKS_ENABLED=true` (defaults to `true` when unset in production)
- scheduler lock operations do not fall back to in-memory local locks in `production`

Server default URL: `http://localhost:8787`

## Endpoints

- `GET /health`
- `POST /api/auth/anonymous`
- `POST /api/auth/refresh`
- `GET /api/auth/me`
- `POST /api/auth/apple-link`
- `POST /api/auth/logout`
- `GET /api/cities/search?query=berlin&count=6&language=en`
- `GET /api/astrology/birth-profile` (Bearer token required)
- `PUT /api/astrology/birth-profile` (Bearer token required)
- `POST /api/astrology/natal-chart` (Bearer token required, cached by profile hash)
- `GET /api/astrology/daily-transit` (Bearer token required, generated daily and cached in DB)
- `GET /api/astrology/ai-synergy/history?days=30&limit=30` (Bearer token required, returns stored daily AI synergy history)
- `GET /api/astrology/morning-briefing?refresh=true|false` (Bearer token + premium required, widget-ready daily payload)
- `GET /api/astrology/full-natal-analysis?refresh=true|false` (Bearer token + premium required, cached premium report)
- `POST /api/astrology/full-natal-analysis/regenerate` (Bearer token + premium required, force regenerate report)
- `GET /api/astrology/career-insights?tier=free|premium&regenerate=false` (Bearer token required, cached by user/profile/tier/promptVersion/model)
- `GET /api/astrology/discover-roles?query=&limit=5&searchLimit=20&refresh=false` (Bearer token required, seeds O*NET catalog, caches personalized recommendations by user/profile/algorithmVersion)
- `GET /api/jobs/limits` (Bearer token required, returns current usage limits)
- `GET /api/jobs/metrics?windowHours=24` (Bearer token required, parser quality metrics by source/status)
- `GET /api/jobs/alerts?windowHours=24` (Bearer token required, alert evaluation for scraping health thresholds)
- `POST /api/jobs/preflight` (Bearer token required, validates URL + cache status)
- `POST /api/jobs/analyze` (Bearer token required, provider fallback + cache + deterministic scoring)
- `POST /api/jobs/analyze-screenshots` (Bearer token required, parses uploaded screenshot data URLs via vision model + deterministic scoring)
- `GET /api/billing/subscription` (Bearer token required, returns user snapshot + billing projection)
- `POST /api/billing/revenuecat/sync` (Bearer token required, manual RevenueCat sync)
- `POST /api/billing/revenuecat/webhook` (RevenueCat server-to-server webhook, bearer token required)
- `PUT /api/notifications/push-token` (Bearer token required, stores/upserts Expo push token)
- `PUT /api/notifications/burnout-settings` (Bearer token + premium required, stores burnout alert preferences)
- `GET /api/notifications/burnout-plan` (Bearer token + premium required, returns current burnout risk and scheduling status)
- `PUT /api/notifications/lunar-productivity-settings` (Bearer token + premium required, stores lunar productivity alert preferences)
- `GET /api/notifications/lunar-productivity-plan` (Bearer token + premium required, returns current lunar productivity risk and scheduling status)
- `PUT /api/notifications/interview-strategy-settings` (Bearer token + premium required, stores interview strategy preferences and autofill confirmation state)
- `GET /api/notifications/interview-strategy-plan?refresh=true|false` (Bearer token + premium required, returns server-generated interview slots and rolling horizon metadata)

Dedicated worker process runs internal schedulers for:
- daily transit generation at midnight server time
- job metrics alerts evaluation (`JOB_METRICS_ALERT_*`)
- burnout alert planning and Expo push dispatch (`BURNOUT_ALERT_*`)
- interview strategy rolling-horizon refill (`INTERVIEW_STRATEGY_*`)

Legacy combined runtime (`start:all` / `dev:all`) still exists for local development and operational fallback.

## Docs

- `docs/auth-and-session-contract.md`
- `docs/backend-api-runtime-map.md`
- `docs/jobs-api-contract.md`
- `docs/mongo-collections-and-indexes.md`
- `docs/notifications-and-billing-contracts.md`
- `docs/redis-cache-and-locks-current-state.md`
- `docs/morning-briefing-api.md`
- `docs/llm-gateway-current-state.md`
- `docs/redis-cache-plan.md`
- `docs/documentation-audit-2026-03-29.md`
