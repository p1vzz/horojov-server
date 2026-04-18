# LLM Gateway - Current State
**Status:** Active  
**Last synced:** 2026-04-13

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
  - fallback behavior when LLM is disabled or invalid
- `llmTelemetry.ts` owns cost estimation and Mongo persistence for gateway events.
- `src/services/llmEvals.test.ts` now guards the feature-owned normalizers with golden valid and invalid payload cases.

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

## Not Implemented Yet

- shared prompt template registry separate from service files
- telemetry dashboards or admin-facing reporting views
- richer retry controls per feature tier/provider

## Related Files

- `src/services/llmGateway.ts`
- `src/services/llmTelemetry.ts`
- `src/services/llmPromptRegistry.ts`
- `src/services/llmGateway.test.ts`
- `src/services/llmTelemetry.test.ts`
- `src/services/llmPromptRegistry.test.ts`
- `src/services/llmEvals.test.ts`
