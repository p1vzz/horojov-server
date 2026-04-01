---
name: mongo-contracts
description: Use this skill when changing MongoDB collection shapes, indexes, query shapes, aggregation pipelines, pagination queries, schema compatibility, or handling of legacy documents in the backend. Use it for persistence-layer work and data-shape safety. Do not use it for React Native changes or API-layer-only changes that do not materially affect the data layer.
---

# Goal

Make MongoDB-related changes safely, with explicit attention to schema compatibility,
query behavior, and long-lived data.

# Apply when

Use this skill when the task involves:
- collection/schema changes
- indexes
- query shape changes
- aggregation pipelines
- pagination implementation at the data layer
- compatibility with existing documents
- legacy/null/missing field handling
- performance-sensitive Mongo queries

Typical trigger phrases:
- add index
- update schema
- change Mongo query
- fix query performance
- support legacy documents
- add cursor pagination
- update aggregation
- change Mongo model

# Primary priorities

1. Preserve compatibility with existing data where practical.
2. Keep Mongo logic centralized in existing data-access touchpoints (`src/db/mongo.ts`, shared services/helpers, or route-local query blocks already used in this repo).
3. Inspect both read and write paths before changing data shape.
4. Be explicit about nullability, defaults, and missing legacy fields.
5. Note performance and indexing implications when query behavior changes.

# Do

- inspect existing collection typing/index code (`src/db/mongo.ts`) and current query sites before changing schema/query behavior
- check who reads and writes the affected fields
- prefer additive schema evolution over destructive changes
- use narrow projections when large documents are unnecessary
- keep indexes aligned with actual query patterns
- call out migration/backfill needs when relevant
- treat missing old fields as a normal compatibility case when appropriate
- keep pagination strategy consistent with current service/route patterns

# Do not

- do not duplicate the same raw Mongo query logic in multiple route/service files when it can be extracted safely
- do not assume every document already matches the newest shape
- do not introduce destructive schema assumptions silently
- do not add indexes casually without mentioning why
- do not optimize blindly without understanding current query paths
- do not expose Mongo internals directly as public API contracts unless the codebase intentionally does so

# Workflow

For non-trivial Mongo changes:

1. inspect the affected collections/types/indexes in `src/db/mongo.ts` and the current query call sites
2. inspect read paths and write paths
3. identify compatibility concerns with existing documents
4. implement the narrowest safe change
5. verify performance-sensitive paths if applicable
6. summarize compatibility and index/performance impact

# Compatibility checklist

Check these explicitly:
- old documents missing new fields
- null vs absent field handling
- default values on read vs write
- enum expansion
- id serialization expectations
- index coverage for changed query shape
- pagination stability
- aggregation behavior on mixed-shape data

# Performance checklist

When query performance matters:
- identify the actual filter/sort path
- check whether an index supports it
- reduce overfetching
- avoid unnecessary pipeline stages
- note when a change may require an index or migration

# Output quality bar

A good result:
- keeps Mongo logic contained
- preserves data compatibility
- explains schema/query impact clearly
- avoids hidden destructive assumptions
- mentions performance/index implications when relevant
