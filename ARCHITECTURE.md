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
- read request params/query/body/cookies
- validate request input with the module's Zod schemas
- call the service
- shape the HTTP response

Controllers should not contain Prisma queries or business rules.

### Routes

Route files should stay small and declarative:
- instantiate/wire repository -> service -> controller
- attach shared or module-local middleware
- map URLs to controller methods

Do not put validation, database access, or business logic in route files.

A separate DI framework/container is not needed unless the project becomes complex enough to justify one.

### Service

Services are classes.

Services own business/application logic:
- authorization decisions that are part of the use case
- orchestration between repositories/providers
- state transitions
- provider workflow logic

Services do not parse Express requests.

### Repository

Repositories are classes and are the domain module's Prisma/database layer.

Put normal database reads/writes here instead of scattering Prisma calls through controllers and services. Transactions that implement one database operation can also live here.

Infrastructure-only code such as application health checks may access infrastructure directly when a repository would add no value.

### Schema

Each module has a schema file when it accepts or parses structured input.

Use Zod for:
- request body validation
- route params
- query params
- important external/provider response shapes

Controllers perform request validation using these schemas. Provider response validation may happen in the service where the provider call is handled.

### Utils

Keep small related helpers in one module utility file rather than creating many tiny files.

Use regions/comments inside a larger cohesive file when that improves navigation. Split a utility into another file only when it becomes a genuinely separate responsibility.

## Middleware placement

Middleware that is reused across modules belongs in:

```text
src/middleware/
```

Examples:
- authentication (`requireAuth`)
- request-wide authorization/context middleware
- error handling
- rate limiting when added

Middleware that is truly specific to one module may stay inside that module.

Do not keep a middleware inside Auth merely because it authenticates a user if the rest of the application depends on it.

## Keep modules compact

Do not create separate `client`, `manager`, `handler`, `helper`, `validator`, and `adapter` files by default.

Prefer the six core module files above. If a service or utility grows into multiple genuinely independent responsibilities, split it then.

For example, a small provider HTTP client can stay in a clearly marked region of the provider service. Extract it only when it becomes large, independently testable, reused, or difficult to navigate.

## Dependency direction

The normal request path is:

```text
Route -> Controller -> Service -> Repository -> Prisma/PostgreSQL
```

Utilities and schemas support those layers without owning business state.

Cross-module use should normally happen through the other module's service rather than reaching directly into its repository.

## Tenancy rule

`Store` is the operational tenant boundary and the default ML/data isolation boundary.

There is no Organization layer in the current architecture.

All merchant-owned data and future ML features must remain explicitly store-scoped unless a later product requirement deliberately introduces a broader aggregation level.
