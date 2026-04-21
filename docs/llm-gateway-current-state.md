# LLM Gateway - Current State
**Status:** Active  
**Last synced:** 2026-04-21

## Goal

Document the current shared transport layer for OpenAI-backed structured outputs.

## Implemented

- Shared transport module: `src/services/llmGateway.ts`
- Shared prompt/config registry: `src/services/llmPromptRegistry.ts`
- Persisted telemetry sink: `src/services/llmTelemetry.ts`
- Transport responsibilities now centralized:
  - `chat/completions` request construction
  - auth header wiring
  - `response_format: json_schema`
  - timeout handling
  - bounded retry policy with exponential backoff
  - response JSON parsing
  - upstream error shaping
  - usage token extraction
- Shared gateway event telemetry:
  - success and failure events by feature
  - duration, schema name, model, and token usage metadata
  - attempt count and prompt version metadata
  - persisted Mongo docs in `llm_gateway_telemetry`
  - estimated input/output/total USD cost when per-token env rates are configured
  - failure stage classification (`config`, `transport`, `upstream`, `response_content`, `response_json`)
- Golden regression coverage for feature normalizers:
  - screenshot parser
  - career insights
  - interview strategy explanations
  - full natal analysis
  - AI synergy narrative
  - Career Vibe plan narrative

## Services Migrated

- `src/services/jobScreenshotParser.ts`
- `src/services/careerInsights.ts`
- `src/services/interviewStrategy.ts`
- `src/services/fullNatalAnalysis.ts`
- `src/services/aiSynergy.ts`
- `src/services/careerVibePlan.ts`

## Current Boundary

- `llmGateway.ts` handles transport only.
- Each feature service still owns:
  - system/user prompt text
  - JSON schema body
  - domain normalization/validation of parsed payload
- `llmStructuredFallback.ts` owns primary/backup structured completion routing and stable failure classification.
- `llmTelemetry.ts` owns cost estimation and Mongo persistence for gateway events.
- `src/services/llmEvals.test.ts` now guards the feature-owned normalizers with golden valid and invalid payload cases.
- Runtime dashboard-facing endpoints avoid synchronous LLM waits where possible:
  - `/api/astrology/daily-transit` uses cached AI Synergy by default and only generates it when `includeAiSynergy=true`; if narrative generation fails, score payload remains with `narrativeStatus=failed|unavailable`.
  - `/api/astrology/career-vibe-plan?refresh=false` returns cached output first or a metrics-only `plan=null` payload with `narrativeStatus=pending`; premium narrative generation can complete in the background.
  - `/api/notifications/interview-strategy-plan` returns deterministic slot explanations first; provider polish can run in the background and sets `explanationSource=llm` only on successful replacement.

Template policy:
- API responses must not surface fabricated template reports or narrative as successful provider output.
- If all configured providers fail, feature services return a typed failure/status that the mobile client maps to user-facing copy.
- Provider/model/source names stay in logs and technical surfaces, not production UI.

## Prompt Registry Scope

`llmPromptRegistry.ts` is the source of truth for:

- model
- promptVersion
- temperature
- maxTokens
- request timeout

`llmGateway.ts` retry behavior is configured through env:

- `OPENAI_MAX_RETRIES`
- `OPENAI_RETRY_BASE_DELAY_MS`
- `OPENAI_RETRY_MAX_DELAY_MS`

Telemetry persistence is configured through env:

- `OPENAI_TELEMETRY_ENABLED`
- `OPENAI_TELEMETRY_RETENTION_DAYS`
- `OPENAI_COST_INPUT_USD_PER_1M_TOKENS`
- `OPENAI_COST_OUTPUT_USD_PER_1M_TOKENS`

Current prompt registry entries:

- career insights (`free`, `premium`)
- screenshot parser
- interview strategy
- full natal analysis
- AI synergy
- Career Vibe plan

Backup provider env:

- `LLM_BACKUP_API_KEY`
- `LLM_BACKUP_BASE_URL`
- `LLM_BACKUP_MODEL` for shared default backup model
- feature overrides: `LLM_BACKUP_AI_SYNERGY_MODEL`, `LLM_BACKUP_CAREER_INSIGHTS_MODEL`, `LLM_BACKUP_JOB_SCREENSHOT_MODEL`, `LLM_BACKUP_CAREER_VIBE_PLAN_MODEL`, `LLM_BACKUP_INTERVIEW_STRATEGY_MODEL`, `LLM_BACKUP_FULL_NATAL_ANALYSIS_MODEL`

## Not Implemented Yet

- shared prompt template registry separate from service files
- telemetry dashboards or admin-facing reporting views
- richer retry controls per feature tier/provider

## Related Files

- `src/services/llmGateway.ts`
- `src/services/llmStructuredFallback.ts`
- `src/services/llmTelemetry.ts`
- `src/services/llmPromptRegistry.ts`
- `src/services/llmGateway.test.ts`
- `src/services/llmTelemetry.test.ts`
- `src/services/llmPromptRegistry.test.ts`
- `src/services/llmEvals.test.ts`
