# Skills Usage Log

Track non-trivial backend tasks to measure skill routing quality and real invocation frequency.

| Date (UTC) | Task Summary | Primary Skill | Secondary Skills | Outcome |
| --- | --- | --- | --- | --- |
| 2026-03-29 | Backend audit for AGENTS/skills/documentation alignment and contract coverage | node-api | mongo-contracts | Completed |
| 2026-03-30 | Backend documentation hardening for jobs/auth/mongo/redis contracts and AGENTS/README sync | node-api | mongo-contracts | Completed |
| 2026-03-30 | Implemented lunar productivity notification API routes and Mongo persistence contract | node-api | mongo-contracts | Completed |
| 2026-03-30 | Added server verify command (`check+test+build`) and AGENTS runtime script sync | node-api | release-smoke-checks | Completed |
| 2026-03-30 | Expanded route test coverage for auth, billing, and notifications via DI-based route dependencies | node-api | mongo-contracts, release-smoke-checks | Completed |
| 2026-03-30 | Added advanced billing webhook and notifications flow tests (processed/failed burnout/interview branches) | node-api | release-smoke-checks | Completed |
| 2026-03-30 | Added CI route smoke runner with consolidated `ci:smoke` command (`verify + route inject checks`) | release-smoke-checks | node-api | Completed |
| 2026-03-31 | Server api/worker runtime split and production scheduler lock hardening | node-api | mongo-contracts | Completed |
| 2026-03-31 | Shared OpenAI gateway and prompt registry for AI services | node-api | mongo-contracts | Completed |
| 2026-04-01 | Added LLM gateway telemetry, golden eval regressions, and cross-repo contract sync skill | node-api | mobile-server-contract-sync, skill-creator | Completed |
| 2026-04-01 | Normalized server import style across astrology and jobs modules | node-api | none | Completed |
| 2026-04-01 | Added shared LLM retry policy, persisted telemetry, scripts tsconfig, and lint gates across repos | node-api | testing-quality, mobile-server-contract-sync | Completed |
| 2026-04-10 | Added lunar productivity planner/dispatch scheduler, runtime lock/env wiring, and current-day timing contract handling | node-api | mobile-server-contract-sync, mongo-contracts | Completed |
| 2026-04-10 | Switched lunar productivity push thresholds to extreme supportive/disruptive bands and updated scheduler direction handling | node-api | mobile-server-contract-sync, mongo-contracts | Completed |
| 2026-04-10 | Added lunar in-app acknowledge flow, impact-direction contract fields, and same-day view suppression for pending pushes | node-api | mobile-server-contract-sync, mongo-contracts | Completed |
| 2026-04-10 | Rewrote lunar productivity push copy and timezone validation toward action-oriented production guidance | node-api | mobile-server-contract-sync, testing-quality | Completed |
| 2026-04-11 | Scoped lunar productivity same-day jobs to the active birth-profile hash to avoid stale onboarding timing collisions | node-api | mobile-server-contract-sync, mongo-contracts, testing-quality | Completed |
| 2026-04-12 | Hardened burnout alert planner with profileHash-scoped jobs, in-app seen acknowledgement, stale-job cancellation, and production push copy | node-api | mobile-server-contract-sync, mongo-contracts, testing-quality | Completed |
| 2026-04-13 | Removed synchronous AI synergy generation from burnout and lunar alert plan paths | node-api | mobile-server-contract-sync, testing-quality | Completed |
| 2026-04-13 | Added burnout hourly stress scheduling, push-token scheduler guards, and scheduler regression tests | node-api | mobile-server-contract-sync, testing-quality | Completed |
| 2026-04-13 | Added durable burnout alert event trail for scheduler and seen outcomes | node-api | mongo-contracts, mobile-server-contract-sync, testing-quality | Completed |
| 2026-04-13 | Implemented Career Vibe P0 as a cached daily plan endpoint with optional premium LLM narrative and widget-safe morning briefing snapshot | node-api | mobile-server-contract-sync, mongo-contracts, testing-quality | Completed; backend verify, route smoke, mobile verify, and Android debug build passed |
| 2026-04-15 | Implemented Job Position Check technical release fixes across cached response parity and technical endpoint gating | mobile-server-contract-sync | node-api, testing-quality | Completed; backend verify and route smoke passed |
| 2026-04-16 | Accepted LinkedIn jobs currentJobId links for Job Position Check | mobile-server-contract-sync | node-api, testing-quality | Canonicalized LinkedIn jobs surfaces with numeric currentJobId; backend verify and route smoke passed |
| 2026-04-17 | Raised job screenshot fallback limit to six | mobile-server-contract-sync | node-api, testing-quality | Updated screenshot max-image default and contract docs to 6 while keeping byte limits unchanged; backend verify passed |
| 2026-04-17 | Hardened Job Position Check release docs tests and production gates | mobile-server-contract-sync | node-api, testing-quality | Added production env guards, relaxed screenshot parser optional-field handling, updated contract docs; backend verify and route smoke passed |
| 2026-04-18 | Reworked Interview Strategy into sparse natal-aware monthly windows and removed manual range settings | mobile-server-contract-sync | node-api, mongo-contracts, testing-quality | Completed; backend and mobile verify passed |
| 2026-04-18 | Fixed Interview Strategy generation timeout and natal chart readiness flow | mobile-server-contract-sync | node-api, testing-quality | Settings save no longer runs heavy generation; plan route handles generation with verified mobile/server checks |
| 2026-04-19 | Implemented auto-managed Interview Strategy premium flow with device-local calendar removal | mobile-server-contract-sync | node-api, mongo-contracts, testing-quality | Completed; expired slot cleanup added and backend verify passed |
| 2026-04-19 | Refined Interview Strategy calendar reminders copy analytics and zero-result fallback | mobile-server-contract-sync | node-api, testing-quality | Completed; zero-result fallback heuristic documented and targeted backend checks passed |
| 2026-04-19 | Fixed Full Career Analysis failure fallback | mobile-server-contract-sync | node-api, testing-quality | Full natal analysis now returns template payload on LLM failure or invalid payload; backend verify passed |
| 2026-04-19 | Added Full Career Analysis cache-only dashboard contract | mobile-server-contract-sync | node-api, testing-quality | Full natal analysis supports cacheOnly dashboard checks without generation; backend verify passed |
| 2026-04-19 | Reduced runtime dashboard LLM waits | node-api | mongo-contracts, testing-quality | Daily transit uses cached AI Synergy by default, Career Vibe is template-first with background enhancement, and Interview Strategy API uses background LLM polish |
| 2026-04-20 | Removed LLM template narrative fallbacks across AI Synergy and Career Vibe contracts | mobile-server-contract-sync | node-api, testing-quality | Completed; backend/mobile verify quiet and backend route smoke passed |
| 2026-04-21 | Connected Career Insights and Screenshot Parser to shared provider backup | mobile-server-contract-sync | node-api, testing-quality | Completed; backend/mobile verify quiet and backend route smoke passed |
