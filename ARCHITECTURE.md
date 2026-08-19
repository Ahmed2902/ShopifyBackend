# Backend Architecture

This file defines the default structure for backend modules in this repository. Keep the structure consistent, but do not create files that have no real responsibility.

## Module convention

A normal feature module should look like this:

```text
src/modules/<module>/
  <module>.controller.ts
  <module>.routes.ts
  <module>.service.ts
  <module>.repository.ts
  <module>.schema.ts
  <module>.utils.ts
```

Tests live beside the code they test when that keeps the module easier to navigate.

## Responsibilities

### Controller

Controllers are classes.

Controllers own HTTP concerns:
- read endpoint-specific request params/query/body/cookies
- validate endpoint-specific request input with the module's Zod schemas
- call the service
- shape the HTTP response

Controllers should not contain Prisma queries, generic authentication/store-access checks, or business rules.

### Routes

Route files should stay small and declarative:
- instantiate/wire repository -> service -> controller
- attach shared or module-local middleware
- map URLs to controller methods

Generic request prerequisites such as authentication, Store membership, and coarse Store-role checks belong here as middleware before the controller runs.

Do not put database access or business logic in route files. Middleware may validate the request data that it specifically needs, such as the standard `:storeId` parameter.

A separate DI framework/container is not needed unless the project becomes complex enough to justify one.

### Service

Services are classes.

Services own business/application logic:
- orchestration between repositories/providers
- state transitions
- provider workflow logic
- resource-specific authorization only when it is genuinely part of the business use case

Services do not parse Express requests and must not repeat generic authentication, Store-membership, or Store-role checks for HTTP routes. Those prerequisites are established by route middleware before the controller executes.

### Repository

Repositories are classes and are the domain module's Prisma/database layer.

Put normal database reads/writes here instead of scattering Prisma calls through controllers and services. Transactions that implement one database operation can also live here.

Tenant-owned queries must still be scoped by the trusted `storeId` where applicable, even after route middleware has authorized the request. Middleware protects route access; Store-scoped queries provide a second isolation boundary at the data layer.

Infrastructure-only code such as application health checks may access infrastructure directly when a repository would add no value.

### Schema

Each module has a schema file when it accepts or parses structured input.

Use Zod for:
- request body validation
- endpoint-specific route params
- query params
- important external/provider response shapes

Controllers perform endpoint-specific request validation using these schemas. Provider response validation may happen in the service where the provider call is handled.

Middleware validates only the data that the middleware itself needs. For example, `requireStoreMembership` validates the shared `:storeId` route parameter before performing the membership lookup.

### Utils

Keep small related helpers in one module utility file rather than creating many tiny files.

Use regions/comments inside a larger cohesive file when that improves navigation. Split a utility into another file only when it becomes a genuinely separate responsibility.

## Request context and authorization

Trusted request identity/context is built progressively by middleware before controllers run.

### Request context

The application initializes:

```ts
req.context = {};
```

Shared middleware then adds trusted values as they are verified.

### Authentication

`requireAuth` verifies the bearer access token and writes the JWT subject to:

```ts
req.context.userId
```

The access token contains user identity only (`sub = userId`). Store roles do not belong in the JWT because a user can have a different role per Store and roles can change independently of token lifetime.

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

### Store roles

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

Resource-specific/business authorization stays in the service when it is genuinely part of the business rule rather than generic route access.

## Middleware placement

Middleware that is reused across modules belongs in:

```text
src/middleware/
```

Examples:
- authentication (`requireAuth`)
- Store access (`requireStoreMembership`, `requireRole`)
- error handling
- rate limiting when added

Middleware that is truly specific to one module may stay inside that module.

Do not keep middleware inside Auth merely because it authenticates a user if the rest of the application depends on it.

## Keep modules compact

Do not create separate `client`, `manager`, `handler`, `helper`, `validator`, and `adapter` files by default.

Prefer the six core module files above. If a service or utility grows into multiple genuinely independent responsibilities, split it then.

For example, a small provider HTTP client can stay in a clearly marked region of the provider service. Extract it only when it becomes large, independently testable, reused, or difficult to navigate.

## Dependency direction

The normal request path is:

```text
Route middleware -> Controller -> Service -> Repository -> Prisma/PostgreSQL
```

Utilities and schemas support those layers without owning business state.

Cross-module business use should normally happen through the other module's service rather than reaching directly into its repository. Shared access middleware is allowed to use the Store repository for the narrow membership lookup because that check is an HTTP prerequisite rather than Store business logic.

## Tenancy rule

`Store` is the operational tenant boundary and the default ML/data isolation boundary.

There is no Organization layer in the current architecture.

All merchant-owned data and future ML features must remain explicitly Store-scoped unless a later product requirement deliberately introduces a broader aggregation level.
