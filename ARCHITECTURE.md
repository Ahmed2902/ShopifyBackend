# Backend Architecture

The backend follows one rule above everything else: **keep the request path obvious**.

A developer should be able to open a feature folder and understand the HTTP entrypoint, business logic, persistence, and provider boundary without tracing a dependency container or framework-specific wiring.

Security stays strict, but security concerns belong in clear middleware/protocol boundaries rather than extra architectural layers.

## Default feature shape

Most features should look like this:

```text
feature/
  feature.routes.ts
  feature.controller.ts
  feature.service.ts
  feature.repository.ts   # only when persistence is substantial
  feature.schema.ts       # when request/query validation is needed
  feature.utils.ts        # small feature-specific helpers only
```

Responsibilities:

- `*.routes.ts` — endpoints and route-level guards only.
- `*.controller.ts` — HTTP translation and endpoint-specific validation.
- `*.service.ts` — business rules and orchestration.
- `*.repository.ts` — Prisma/database access.
- `*.schema.ts` — Zod request/query/parameter schemas.
- `*.utils.ts` — small protocol/domain helpers that do not deserve their own layer.

Classes remain injectable so focused tests can construct them with mocks. The normal application singleton is exported from the same feature file:

```ts
export class ExampleService {
  constructor(private readonly repository: ExampleRepository) {}
}

export const exampleService = new ExampleService(new ExampleRepository());
```

Controllers follow the same pattern. Routes import the ready controller and remain declarative.

Do **not** add `*.module.ts` composition containers, factories, managers, adapters, handlers, or provider frameworks unless a concrete problem requires them. Two duplicated lines are often cheaper than a premature abstraction.

## When a feature may split further

Large external-provider domains have real complexity. A feature may use subfolders when a resource family owns substantial logic/data contracts of its own.

Examples that justify a split:

- Shopify bulk operations
- Shopify orders/refunds
- Shopify webhooks
- Meta campaign/ad hierarchy
- Meta catalogs
- Meta Insights
- Meta product/ad mapping

The goal is **not** one giant service file. The goal is to avoid layers that merely forward calls.

## Request flow

The normal request path is:

```text
route
  -> middleware/guards
  -> controller
  -> service
  -> repository/provider API
```

A layer should exist because it owns a responsibility, not because an architecture diagram has a box for it.

## Request context and authorization

Trusted identity is established before business code runs.

### Authentication

Login and refresh load the user's current `StoreMembership` rows and encode Store access claims in the short-lived access token:

```ts
{
  sub: userId,
  stores: [{ storeId, role }]
}
```

`requireAuth` verifies issuer, audience, algorithm and expiry, then writes identity and token snapshot data to:

```ts
req.context.userId
req.context.storeAccess
```

The Store claims are useful as a short-lived snapshot, but they are **not** the authorization source of truth for protected Store routes.

### Store membership

For Store-scoped routes, `requireStoreMembership` runs after `requireAuth`:

1. validate `:storeId`
2. load the current `StoreMembership` row by trusted `userId + storeId`
3. reject a removed/missing membership without revealing whether the Store exists
4. attach the current database role:

```ts
req.context.storeId
req.context.role
```

This makes membership revocation and OWNER/ADMIN/MEMBER role changes effective immediately instead of waiting for the access token to expire. Persistence stays behind `StoreRepository`; middleware does not access Prisma directly.

### Roles

`requireRole(...roles)` checks the already-selected current Store role. Generic authentication/membership/role prerequisites belong in middleware; resource-specific authorization remains in the service when it is part of the business rule.

Repositories still scope tenant-owned queries by trusted `storeId`. Route authorization and Store-scoped persistence are separate isolation boundaries.

## Validation

Middleware validates values that middleware itself needs, such as the standard Store parameter.

Controllers validate endpoint-specific bodies, query strings and resource parameters with Zod before calling services.

Validation logic should not be duplicated inside the service unless the same business invariant must also hold for non-HTTP callers.

## Security baseline

Readability must never be achieved by weakening boundaries. The backend keeps security mechanisms small and centralized:

- short-lived signed access tokens with strict issuer/audience/algorithm checks
- opaque refresh tokens stored only as hashes, rotated on use, with reuse detection
- HttpOnly/Secure cookie policy where applicable
- random double-submit CSRF protection on cross-site refresh/logout cookie mutations
- strict frontend-origin validation on cookie-authenticated mutations
- current database-backed Store membership/role authorization
- timing-safe OAuth/HMAC comparisons
- OAuth state, PKCE and nonce validation where the provider supports them
- encrypted provider credentials/tokens at rest
- exact provider identity/account checks before accepting sync data
- raw-body webhook signature verification before processing
- durable webhook idempotency and bounded retries
- request-body size limits
- sanitized request IDs, Helmet and explicit CORS

Distributed abuse/rate limiting belongs at a shared edge or shared store. Do not implement security-sensitive production limits with a process-local in-memory map.

Security middleware remains shared and explicit. Endpoint-specific business validation stays in controllers/services rather than becoming a generic policy framework.

## Provider modules

Provider code uses the same architecture as normal features. Provider-specific database models stay provider-specific when the APIs have different semantics; the intelligence layer receives normalized contracts later.

A provider root service is the public orchestration boundary. Subfeatures own substantial resource families.

### Shopify

```text
shopify/
  shopify.routes.ts
  shopify.controller.ts
  shopify.service.ts
  shopify.repository.ts
  shopify.schema.ts
  shopify.types.ts
  shopify.utils.ts

  shared/
    shopify-api.service.ts
    shopify-auth.service.ts

  catalog/
  inventory/
  bulk/
  order/
  read/
  webhook/
```

`ShopifyService` coordinates OAuth, sync, order backfills, reconciliation and webhook processing. It delegates provider/resource details to the focused subfeature instead of duplicating them or becoming a giant provider client.

Historical datasets that are naturally large use Shopify Bulk Operations. JSONL results are streamed rather than loaded entirely into memory. Order/refund ingestion intentionally excludes direct customer PII and preserves channel/test-order metadata needed for analytics and ML quality.

### Meta

```text
meta/
  meta.routes.ts
  meta.controller.ts
  meta.service.ts
  meta.repository.ts
  meta.schema.ts
  meta.types.ts
  meta.utils.ts

  shared/
    meta-api.service.ts
    meta-auth.service.ts

  ads/
  catalog/
  insights/
  mapping/
```

The provider transport/auth helpers are justified because token lifecycle, retries, pagination, throttling and identity checks are reused across several resource families. They are protocol boundaries, not generic abstraction layers.

TikTok should follow the same shape. Shared cross-platform abstractions are introduced only for behavior that is truly identical after both providers exist; provider API/persistence semantics remain local to the provider.

## Sync lifecycle

Shared integration infrastructure owns provider-neutral operational records such as `SyncRun` and raw `ExternalPayload` persistence.

Every provider sync must:

- be Store-scoped
- be idempotent at persistence boundaries
- record success/failure in its SyncRun
- preserve useful provider evidence/raw payloads where required
- validate that returned data belongs to the expected provider account/store
- avoid deleting current data when a provider response is partial/incomplete

## Webhooks

Webhook HTTP handlers verify and durably persist first; business work happens after acknowledgement.

For Shopify:

1. preserve exact raw request body
2. verify `X-Shopify-Hmac-Sha256` with timing-safe comparison
3. normalize/validate shop identity
4. deduplicate by provider webhook ID
5. persist the delivery
6. acknowledge HTTP request
7. process asynchronously with bounded retries and stale-claim recovery

Mutable resources are refetched through the canonical provider API where appropriate instead of treating a webhook payload as the final internal model.

TikTok/Meta webhook implementations should follow the same security and idempotency principles while respecting their provider-specific signature/event contracts.

## Workers

Background worker lifecycle is infrastructure and lives in `src/workers.ts`.

Feature services expose the work operation; `workers.ts` only schedules/start/stops the workers. `server.ts` should remain concerned with HTTP process startup and graceful shutdown.

## Tenancy

`Store` is the operational tenant boundary and default data/ML isolation boundary.

There is no Organization layer today. Merchant-owned data and future intelligence/ML features remain explicitly Store-scoped unless a real product requirement introduces a broader aggregation level.

## Simplicity rule for future work

Before adding a new abstraction, ask:

1. Does it remove real duplicated behavior, or only rename it?
2. Can a developer follow the request path without opening unrelated composition files?
3. Does the abstraction preserve provider-specific correctness and security?
4. Can the same result be achieved with one focused service/helper instead?

Prefer the smallest design that remains secure, testable and explicit.
