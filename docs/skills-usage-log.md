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
| 2026-04-21 | Fixed AI Synergy and Career Vibe pending lifecycle | mobile-server-contract-sync | node-api, testing-quality | Completed; pending cache no longer sticks forever, backend/mobile verify quiet and backend route smoke passed |
| 2026-04-21 | Tightened Career Vibe LLM summary bounds for fixed mobile layout | mobile-server-contract-sync | node-api, testing-quality | Completed; prompt and schema enforce a two-sentence 90-180 character summary; backend verify passed |
| 2026-04-21 | Added birth profile edit lock contract for Settings inline edit | mobile-server-contract-sync | node-api, mongo-contracts, testing-quality | Completed; PUT birth-profile now returns editLock and blocks changed edits with incremental 429 lock; backend/mobile verify quiet passed |
| 2026-04-22 | Gated backend locks to production-only effective env flags | node-api | mongo-contracts, testing-quality | Completed; scheduler locks and birth-profile edit locks are disabled outside production even when env flags are set; backend verify quiet passed |
| 2026-04-22 | Added CareerOneStop API credentials to backend environment config | node-api | mobile-server-contract-sync | Completed; env schema updated and check:app passed |
| 2026-04-22 | Validated CareerOneStop and O*NET market provider access | node-api | mobile-server-contract-sync | Completed; both providers returned 200 from U.S. VPN path, O*NET env schema added, backend check:app passed |
| 2026-04-22 | Implemented normalized market occupation insight backend contract | node-api | mobile-server-contract-sync, testing-quality | Added CareerOneStop/O*NET provider clients, cached `/api/market/occupation-insight`, Mongo indexes, contract docs, and targeted tests |
| 2026-04-22 | Implemented Job Posting Check Lite/Full market scanner contract | mobile-server-contract-sync | node-api, mongo-contracts, testing-quality | Completed; jobs routes now expose scanDepth, Lite/Full quotas, market enrichment, compatible `/limits`, updated docs, and targeted tests passed |
| 2026-04-22 | Implemented Discover Roles market ranking contract | mobile-server-contract-sync | node-api, testing-quality | Completed; discover roles now supports `rankingMode`, market enrichment, opportunity ranking, updated docs, and targeted tests passed |
| 2026-04-22 | Added posted salary field to job analyze contract | mobile-server-contract-sync | node-api, testing-quality | Completed; normalized job payloads now carry nullable `salaryText`, analyze responses expose it, screenshot responses return null, and targeted tests passed |
| 2026-04-23 | Implemented Natal Chart, Negotiation Prep, and Full Blueprint market context | mobile-server-contract-sync | node-api, testing-quality | Completed; added market career context endpoint, Full Blueprint prompt context, source-safe response fields, docs, and targeted tests |
| 2026-04-23 | Added CareerOneStop logo attribution treatment | mobile-server-contract-sync | node-api, testing-quality | Completed; backend market contract now records shared footer logo behavior and public web TODO |
| 2026-04-23 | Expanded Negotiation Prep market payload | mobile-server-contract-sync | node-api, testing-quality | Completed deterministic negotiation prep fields for anchor strategy, recruiter questions, scripts, offer checklist, red flags, tradeoff levers, next steps, and docs |
| 2026-04-25 | Added public market endpoint for landing compliance surface | mobile-server-contract-sync | node-api, testing-quality | Added `/api/public/market/occupation-insight`, documented the public contract/runtime map, and validated build plus targeted route tests |
