# Auth And Session Contract
**Status:** Active  
**Last synced:** 2026-03-30

## Goal

Document backend auth/session behavior consumed by mobile: token lifecycle, route contracts, and revocation semantics.

## Route Surface (`/api/auth`)

- `POST /anonymous`
- `POST /refresh`
- `GET /me`
- `POST /apple-link`
- `POST /logout`

## Token Model

- Access token: random 32-byte hex string.
- Refresh token: random 48-byte hex string.
- Server stores only SHA-256 hashes (`accessTokenHash`, `refreshTokenHash`).
- Session TTLs:
  - access: `ACCESS_TOKEN_TTL_SECONDS` (default `3600`)
  - refresh: `REFRESH_TOKEN_TTL_SECONDS` (default `15552000`, ~180 days)
- Expired sessions are auto-cleaned by Mongo TTL index on `refreshExpiresAt`.

## Bearer Auth Semantics

`authenticateByAuthorizationHeader` expects `Authorization: Bearer <token>`.

A token is valid only when session matches:

- `accessTokenHash` found
- `revokedAt == null`
- `accessExpiresAt > now`

On success:

- returns user + session context
- user `subscriptionTier` is resolved through effective tier override:
  - if `DEV_FORCE_PREMIUM_FOR_ALL_USERS=true`, effective tier is always `premium`
- `lastSeenAt` is touched at most once per 5 minutes.

## Endpoint Contracts

### `POST /anonymous`

Creates anonymous user + first session.

- `201` success:
  - `user` (public shape)
  - `session` (`accessToken`, `refreshToken`, `accessExpiresAt`, `refreshExpiresAt`)

### `POST /refresh`

Input:

```json
{ "refreshToken": "string(min=16)" }
```

- `400` invalid payload
- `401` invalid/expired refresh token
- `200` success:
  - returns same public user shape + rotated session tokens

Rotation behavior:

- updates existing session record with new token hashes and expiries
- does not create a second parallel session for the same refresh token.

### `GET /me`

- `401` unauthorized
- `200` success:

```json
{ "user": { "...public fields..." } }
```

### `POST /apple-link`

Requires Bearer auth.

Input:

```json
{
  "appleSub": "string(min=8)",
  "email": "optional email",
  "displayName": "optional 1..80"
}
```

- `400` invalid payload
- `401` unauthorized
- `409` `appleSub` already linked to another user
- `404` authenticated user not found during update (rare edge)
- `200` success:
  - upgrades user to `registered`
  - stores `appleSub`, optional `email`, optional `displayName`

### `POST /logout`

Requires body shape:

```json
{ "refreshToken": "optional string(min=16)" }
```

- `400` invalid payload
- `204` success (always best-effort)

Revocation behavior:

- if `refreshToken` provided: revokes matching active refresh session.
- always attempts access-token revocation from Bearer header.

## Public User Shape

All auth responses exposing user use this contract:

```json
{
  "id": "string",
  "kind": "anonymous | registered",
  "subscriptionTier": "free | premium",
  "appleLinked": true,
  "email": "string|null",
  "displayName": "string|null",
  "createdAt": "ISO-8601"
}
```

## Storage And Index Dependencies

Key collections:

- `users`
- `sessions`

Critical indexes:

- `users.appleSub` unique sparse
- `sessions.accessTokenHash` unique
- `sessions.refreshTokenHash` unique
- `sessions.refreshExpiresAt` TTL (`expireAfterSeconds: 0`)

## Source Files

- `src/routes/auth.ts`
- `src/services/auth.ts`
- `src/db/mongo.ts`
