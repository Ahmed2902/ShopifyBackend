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
- Small provider transport helpers such as cursor pagination and throttle-delay calculation stay in the provider `*.utils.ts` file.
- Once a provider module has several substantial resource families, feature-specific code is co-located by feature rather than collected in one giant `service/` directory.
- Shared cross-feature Shopify infrastructure belongs under `shopify/shared/`; today that includes the Admin GraphQL transport and OAuth/token lifecycle services.
- Resource folders such as `shopify/order/`, `shopify/bulk/`, and `shopify/webhook/` keep their service, repository, schema, types, and query documents together when those files are specific to that resource family.
- Lightweight resources that currently need only one focused service, such as catalog and inventory, still get their own feature folder without creating empty repository/schema sublayers.
- Provider GraphQL documents belong in dedicated `*.queries.ts` files once they are large enough to obscure service behavior. Internal cross-service contracts belong in module-local `*.types.ts` files.
- A dedicated provider API service is justified once transport behavior such as authentication failures, retries, throttling, response validation, and GraphQL envelopes is shared across multiple resource syncs.

For Shopify, the root `ShopifyService` remains the public facade and orchestration boundary. Feature code is organized as:

```text
shopify/
  shopify.service.ts
  shopify.module.ts
  shared/
    shopify-api.service.ts
    shopify-auth.service.ts
  catalog/
    shopify-catalog.service.ts
    shopify-catalog.queries.ts
  inventory/
    shopify-inventory.service.ts
    shopify-inventory.queries.ts
  bulk/
    shopify-bulk.service.ts
    shopify-bulk.queries.ts
    shopify-bulk.schema.ts
  order/
    shopify-order.service.ts
    shopify-order.repository.ts
    shopify-order.queries.ts
    shopify-order.schema.ts
    shopify-order.types.ts
  webhook/
    shopify-webhook.service.ts
    shopify-webhook.repository.ts
    shopify-webhook.worker.ts
    shopify-webhook.schema.ts
    shopify-webhook.utils.ts
```

Historical datasets that are naturally large should use Shopify Bulk Operations rather than manual top-level pagination. Order history is started as one asynchronous bulk workflow, the returned provider operation ID is stored on the `SyncRun`, and JSONL results are streamed instead of loaded into memory. Bulk order results contain order rows and nested line-item rows linked through Shopify's `__parentId` field.

Shopify currently does not allow a connection field under the `Order.refunds` list inside a Bulk Operation, so refund headers are included in the bulk order export and `Refund.refundLineItems` are hydrated afterward through one focused refund query (with pagination only if a refund exceeds Shopify's per-request connection limit). This exception is provider-driven and should not reintroduce manual pagination for the whole order history.

Order/refund ingestion intentionally excludes direct customer PII. Money is normalized in shop currency while presentment currency metadata and raw provider payloads remain available for traceability. Test-order and source metadata must be preserved so analytics and ML can exclude fake demand and distinguish sales channels.

## Shopify webhook rule

Shopify webhook delivery is a durable inbox, not request-thread business processing:

1. preserve the exact raw HTTP body before JSON parsing
2. verify `X-Shopify-Hmac-Sha256` with the Shopify app client secret using a timing-safe comparison
3. normalize the shop domain and parse the payload
4. deduplicate with Shopify's `X-Shopify-Webhook-Id`
5. persist the delivery as `QUEUED`
6. acknowledge the HTTP request after durable persistence
7. let the webhook worker claim and process queued deliveries with bounded retries and stale-claim recovery

Webhook payloads are event signals. For mutable Shopify resources, processing refetches the current Admin GraphQL resource and writes it through the same idempotent persistence paths used by reconciliation instead of relying on provider webhook payload shape as the canonical internal model.

Operational webhook coverage includes products, locations, inventory levels, orders, refunds, app uninstall, and bulk-operation completion. Product updates reconcile the product and its full current variant set; missing variants are soft-deleted. Inventory updates append `WEBHOOK_RECONCILIATION` snapshots. Deletions remove or tombstone current state while preserving history where the data model supports it.

`APP_UNINSTALLED` immediately marks the connection `UNINSTALLED` and does not require a working access token. `BULK_OPERATIONS_FINISH` finalizes a matching running order-history `SyncRun`; the explicit GET status endpoint remains a fallback if webhook delivery is delayed or missed.

Webhook subscriptions are application configuration, not runtime business logic. Shopify recommends app-specific subscriptions for uniform topics, so operational topics should be configured once in Shopify app configuration/Dev Dashboard and deployed to all installed shops. The backend only receives, verifies, queues, and processes deliveries; OAuth, manual sync, and backfill do not list/create/update webhook subscriptions through Admin GraphQL.

The app configuration must cover the operational topics handled by this backend: product create/update/delete, inventory-level connect/update/disconnect, location create/update/delete/activate/deactivate, order create/update/delete, refund create, app uninstall, and bulk-operation finish. Mandatory privacy/compliance webhooks must also be configured before public App Store distribution.

Ongoing Store freshness is a separate concern from historical bootstrap. Webhooks provide near-real-time updates, while periodic reconciliation will later call a small set of resource-focused sync functions (catalog, commerce, inventory). Plan/billing policy decides when a Store is due for reconciliation; Shopify services do not contain plan-specific scheduling logic.

Every provider sync must be idempotent at the resource persistence layer, use the Store as its tenant boundary, record failure state in its SyncRun, and preserve relevant raw provider payloads where the data architecture calls for them.

## Tenancy rule

`Store` is the operational tenant boundary and the default ML/data isolation boundary.

There is no Organization layer in the current architecture.

All merchant-owned data and future ML features must remain explicitly Store-scoped unless a later product requirement deliberately introduces a broader aggregation level.
