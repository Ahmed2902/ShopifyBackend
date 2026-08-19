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

`requireAuth` verifies the bearer access token and writes the JWT subject to:

```ts
req.context.userId
```

The access token contains user identity only. Store roles do not belong in the JWT because a user can have a different role per Store and roles can change independently of token lifetime.

### Store membership

For Store-scoped routes, `requireStoreMembership` runs after `requireAuth`:

1. validate `:storeId`
2. read `req.context.userId`
3. query `StoreMembership(userId, storeId)`
4. reject when membership does not exist
5. attach trusted Store context:

```ts
req.context.storeId
req.context.role
```

After this middleware succeeds, downstream controllers/services use the trusted Store ID from request context rather than reading the raw route parameter again.

### Roles

`requireRole(...roles)` runs only after `requireStoreMembership` and uses the already-loaded membership role. It must not issue another membership query.

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

Middleware prevents unauthorized route access; Store-scoped queries provide a second isolation boundary at the database layer.

## Validation rule

Middleware validates data that the middleware itself needs, such as the standard `:storeId` parameter.

Controllers validate endpoint-specific body/query/parameter inputs with the module's Zod schemas before calling services.
