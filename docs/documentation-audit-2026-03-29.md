# Documentation Audit - 2026-03-29
**Scope:** `../horojob-server`  
**Status:** Completed (initial pass 2026-03-29, follow-up pass 2026-03-30)

## Executive Summary

- Core backend implementation is broader than documentation surface.
- `AGENTS.md` and `README.md` had drift from shipped routes/runtime.
- Most missing coverage was cross-cutting operations/contracts, not algorithm internals.

## Snapshot Before This Pass

Covered:
- `docs/morning-briefing-api.md`
- `docs/redis-cache-plan.md` (planning draft)

Missing or drifted:
- unified backend API surface map
- billing + notifications contract doc
- current scheduler/runtime lifecycle doc
- backend skills usage tracking
- `AGENTS.md` layout reality (`docs/` existence was documented incorrectly)
- README endpoint list completeness

## Actions Applied In This Pass

1. Updated `AGENTS.md` to current repo reality:
   - actual routes/modules/docs/skills layout
   - corrected source-of-truth order
   - skill usage logging rule
2. Added `docs/backend-api-runtime-map.md`:
   - route surface by group
   - startup/scheduler/shutdown sequence
   - known scope boundary for lunar notification routes
3. Added `docs/notifications-and-billing-contracts.md`:
   - auth/gating/error contracts for billing + notifications routes
4. Added `docs/skills-usage-log.md`:
   - backend task-level skill tracking baseline
5. Updated `README.md` endpoint list:
   - added missing astrology premium routes
   - added billing routes
   - added docs index section
6. Synced `.env.example` with `src/config/env.ts` defaults:
   - fixed prompt-version drift (`OPENAI_INSIGHTS_PROMPT_VERSION`, `OPENAI_AI_SYNERGY_PROMPT_VERSION`)
   - added missing interview/scheduler variables
   - fixed `JOB_METRICS_ALERTS_ENABLED` example value

## Follow-up Pass - 2026-03-30

Closed items from the initial backlog:

1. Added `docs/jobs-api-contract.md`.
2. Added `docs/auth-and-session-contract.md`.
3. Added `docs/mongo-collections-and-indexes.md`.
4. Added `docs/redis-cache-and-locks-current-state.md`.

Aligned references:

- Updated `AGENTS.md` docs map and source-of-truth section.
- Updated `README.md` docs index.

## Remaining Gaps (Current)

1. Lunar productivity scheduler push-dispatch pipeline remains pending (routes are implemented, full delivery pipeline is still TBD).
2. Redis rollout doc still contains planned caches not yet implemented (`docs/redis-cache-plan.md` remains planning, while current state is now documented separately).
