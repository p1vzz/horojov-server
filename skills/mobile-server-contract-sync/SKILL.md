---
name: mobile-server-contract-sync
description: Use this skill when a task changes or verifies API contracts across ../horojob-server and the Horojob mobile client together. Trigger it for coordinated updates to backend routes, mobile services, DTO parsing, response shapes, contract docs, or smoke checklists that must stay aligned across both repos.
---

# Mobile Server Contract Sync

## Goal

Keep backend route contracts, mobile API consumers, and release docs aligned across
both repositories without introducing silent breaking changes.

## Workflow

1. Inspect the backend contract source first.
   - `src/routes/*.ts`
   - related `src/services/*`
   - focused docs in `docs/*.md`
2. Inspect the mobile consumer side.
   - `../horojob/src/services/*`
   - affected hooks, screens, and components only where mapped data is consumed
   - mobile docs and smoke checklists in `../horojob/docs/*`
3. Prefer additive compatibility.
   - add fields before renaming or removing them
   - keep status and error semantics stable when practical
   - preserve older mobile clients where rollout order can vary
4. Update both repos together when required.
   - backend request or response shape
   - mobile parser and DTO mapping
   - docs and smoke checklists
5. Verify both sides.
   - server: `npm run verify`
   - server: `npm run smoke:routes` when route behavior changes
   - mobile: `npm run verify`
6. Record coordination assumptions.
   - temporary compatibility shims
   - rollout order
   - follow-up cleanup

## Contract Checks

- field names and nullability
- enum expansion and unknown values
- id and ISO date serialization
- premium vs free gating fields
- error body and status code stability
- pagination or cursor metadata
- backward compatibility for released app versions

## Do

- keep route validation and response shaping explicit
- update mobile parsers when contract output changes
- update docs when shipped behavior changes
- call out unavoidable breaking changes explicitly

## Do Not

- do not change response semantics silently
- do not rely on undocumented mobile assumptions
- do not update only one repo when the other clearly depends on the same contract
