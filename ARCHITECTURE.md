# Backend Architecture

## Module convention

A normal business module should stay compact:

- `*.routes.ts` — route wiring and route-level middleware only
- `*.controller.ts` — HTTP request/response handling and endpoint-specific Zod parsing
- `*.service.ts` — business logic only
- `*.repository.ts` — Prisma/database access
- `*.schema.ts` — module-specific Zod schemas and inferred types
- `*.utils.ts` — small module-specific helpers

Controllers, services, and repositories are classes. Routes explicitly compose them without a DI framework.

Do not create extra `client`, `manager`, `handler`, `adapter`, or helper files unless a responsibility becomes large enough to justify the split. Small related logic can stay grouped in regions.

## Request context and authorization

Trusted request identity is built by middleware before controllers run.

### Authentication

Login and refresh load the user's current `StoreMembership` rows once and encode the Store access claims in the short-lived access token:

```ts
{
  sub: userId,
  stores: [
    { storeId, role }
  ]
}
```

`requireAuth` verifies the bearer token and writes the trusted token context to:

```ts
req.context.userId
req.context.storeAccess
```

This avoids a StoreMembership database query on every Store-scoped request. Membership/role changes become visible when a new access token is issued (login or refresh); the access-token TTL therefore bounds how long an old authorization claim can remain valid.

### Store membership

For Store-scoped routes, `requireStoreMembership` runs after `requireAuth`:

1. validate `:storeId`
2. find that Store in the verified token's `storeAccess` claims
3. reject when the token has no matching membership
4. attach the selected trusted Store context:

```ts
req.context.storeId
req.context.role
```

`requireStoreMembership` must not query Prisma.

### Roles

`requireRole(...roles)` runs only after `requireStoreMembership` and checks the already-selected `req.context.role`. It must not issue another membership query.

Example:

```ts
router.post(
  '/settings',
  requireAuth,
  requireStoreMembership,
  requireRole('OWNER', 'ADMIN'),
  controller.update,
);
```

Generic access prerequisites belong in middleware:

- authenticated user
- Store membership
- coarse Store role

Resource-specific/business authorization belongs in the service when it is part of the business rule rather than generic route access.

## Service rule

Services must not repeat generic authentication, Store-membership, or Store-role checks for HTTP routes. Route middleware establishes those prerequisites before the controller executes.

Services receive trusted IDs and implement business behavior.

## Repository rule

Repositories remain tenant-scoped even after route authorization. Queries for tenant-owned resources must include the trusted `storeId` where applicable.

Token-backed route authorization prevents unauthorized route access; Store-scoped queries provide a second isolation boundary at the database layer.

## Validation rule

Middleware validates data that the middleware itself needs, such as the standard `:storeId` parameter.

Controllers validate endpoint-specific body/query/parameter inputs with the module's Zod schemas before calling services.

## Middleware placement

Middleware reused across modules belongs in `src/middleware/`.

Authentication stays in `auth.middleware.ts`. Store membership and Store-role middleware stays in `store.middleware.ts`.

## Provider sync rule

Provider modules keep the same controller/service/repository architecture as the rest of the backend.

- Controllers expose explicit sync operations; they do not contain provider logic.
- Services orchestrate provider requests, validation, retries, normalization, and SyncRun lifecycle calls.
- Repositories contain only Store-scoped database reads/writes.
- Shared integration infrastructure owns `SyncRun` and raw `ExternalPayload` persistence.
- Small provider transport helpers such as cursor pagination and throttle-delay calculation stay in the provider `*.utils.ts` file. A separate API client/adapter should only be introduced when the provider transport becomes large enough to justify it.

Every provider sync must be idempotent at the resource persistence layer, use the Store as its tenant boundary, record failure state in its SyncRun, and preserve relevant raw provider payloads where the data architecture calls for them.

## Tenancy rule

`Store` is the operational tenant boundary and the default ML/data isolation boundary.

There is no Organization layer in the current architecture.

All merchant-owned data and future ML features must remain explicitly Store-scoped unless a later product requirement deliberately introduces a broader aggregation level.
