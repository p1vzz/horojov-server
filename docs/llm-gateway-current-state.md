# LLM Gateway - Current State
**Status:** Active  
**Last synced:** 2026-04-01

## Goal

Document the current shared transport layer for OpenAI-backed structured outputs.

## Implemented

- Shared transport module: `src/services/llmGateway.ts`
- Shared prompt/config registry: `src/services/llmPromptRegistry.ts`
- Transport responsibilities now centralized:
  - `chat/completions` request construction
  - auth header wiring
  - `response_format: json_schema`
  - timeout handling
  - response JSON parsing
  - upstream error shaping
  - usage token extraction
- Shared gateway event telemetry:
  - success and failure events by feature
  - duration, schema name, model, and token usage metadata
  - failure stage classification (`config`, `transport`, `upstream`, `response_content`, `response_json`)
- Golden regression coverage for feature normalizers:
  - screenshot parser
  - career insights
  - interview strategy explanations
  - full natal analysis
  - AI synergy narrative

## Services Migrated

- `src/services/jobScreenshotParser.ts`
- `src/services/careerInsights.ts`
- `src/services/interviewStrategy.ts`
- `src/services/fullNatalAnalysis.ts`
- `src/services/aiSynergy.ts`

## Current Boundary

- `llmGateway.ts` handles transport only.
- Each feature service still owns:
  - system/user prompt text
  - JSON schema body
  - domain normalization/validation of parsed payload
  - fallback behavior when LLM is disabled or invalid
- `src/services/llmEvals.test.ts` now guards the feature-owned normalizers with golden valid and invalid payload cases.

## Prompt Registry Scope

`llmPromptRegistry.ts` is the source of truth for:

- model
- promptVersion
- temperature
- maxTokens
- request timeout

Current prompt registry entries:

- career insights (`free`, `premium`)
- screenshot parser
- interview strategy
- full natal analysis
- AI synergy

## Not Implemented Yet

- shared retry policy
- persisted token/cost telemetry
- prompt template registry separate from service files

## Related Files

- `src/services/llmGateway.ts`
- `src/services/llmPromptRegistry.ts`
- `src/services/llmGateway.test.ts`
- `src/services/llmPromptRegistry.test.ts`
- `src/services/llmEvals.test.ts`
