---
name: node-api
description: Use this skill when modifying HTTP endpoints, routes, services, request validation, response shaping, authorization checks, or backend business logic in the Node.js API. Use it for transport-layer changes and application logic. Do not use it for React Native UI work or MongoDB-only schema/query changes that do not affect endpoint behavior.
---

# Goal

Implement backend API changes while preserving current route/service boundaries,
stable contracts, and predictable endpoint behavior.

# Apply when

Use this skill when the task involves:
- routes
- services
- request validation
- response shaping
- auth checks
- business rules
- endpoint behavior
- pagination/filter semantics at the API layer
- HTTP error handling

Typical trigger phrases:
- add endpoint
- update route
- validate input
- change response shape
- add business rule
- update auth logic
- fix service behavior
- add pagination to endpoint

# Primary priorities

1. Keep route handlers focused and avoid giant endpoint blocks when extraction is practical.
2. Validate input at the boundary.
3. Keep business rules in services/helpers when practical.
4. Preserve public API contracts unless change is explicitly required.
5. Make error behavior consistent with existing patterns.

# Do

- inspect the full request path: route/service/db helper calls
- validate required fields and obvious malformed input
- preserve existing error format where possible
- keep response shaping close to the transport layer if that is the project pattern
- prefer extending an existing service/helper over duplicating logic
- call out breaking changes clearly if they are unavoidable
- keep authorization assumptions explicit

# Do not

- do not place business policy ad hoc across multiple routes when it can live in a shared service/helper
- do not silently change response semantics
- do not trust client input
- do not duplicate database query details in multiple route files unnecessarily
- do not assume the mobile repo has already been updated automatically
- do not refactor unrelated modules as part of a narrow endpoint change

# Workflow

For non-trivial API changes:

1. inspect route/service for the target endpoint
2. inspect current request and response expectations
3. identify validation and auth checks
4. implement the smallest correct change
5. verify edge cases and error behavior
6. summarize contract impact and assumptions

# Validation checklist

Check these when relevant:
- required fields
- invalid types
- enum-like values
- pagination/filter parameters
- authorization access path
- not-found handling
- duplicate/conflict handling
- backward compatibility for older clients

# Response checklist

Check:
- shape stability
- field naming
- nullability/optional behavior
- error structure
- pagination metadata consistency
- serialization of ids and dates

# Output quality bar

A good result:
- keeps route modules maintainable
- keeps business logic in the right layer
- validates input clearly
- preserves API predictability
- documents contract impact when relevant
