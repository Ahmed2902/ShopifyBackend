# Ads Advisor backend: a plain-English guide

This repository is the **backend API** for Ads Advisor. It is a TypeScript/Node.js service that connects a merchant's Shopify shop, imports Shopify catalog, inventory, orders, and refunds into PostgreSQL, and keeps that local data fresh.

There is an adjacent `Frontend` directory, but at the time this guide was written it contains only `README.md`; all working application code is in this `Backend` directory.

## The shortest possible mental model

```text
Browser / future frontend
        |
        v
 Express routes -> controller -> service -> repository -> PostgreSQL
                              |
                              v
                         Shopify Admin GraphQL

Shopify webhooks -> durable database queue -> background worker -> same services
Scheduled worker -----------------------------------------------> same services
```

`Store` is the tenant: every merchant's data belongs to exactly one store. A `User` may be a member of one or more stores, with a role of `OWNER`, `ADMIN`, or `MEMBER`.

## Where to start reading

Read these in order:

1. `package.json` — commands and dependencies.
2. `src/server.ts` — what starts when the process starts.
3. `src/app.ts` then `src/routes.ts` — the HTTP pipeline and every URL group.
4. `ARCHITECTURE.md` — the team's rules for layering, tenancy, syncs, and webhooks.
5. `src/modules/auth/` — a small complete example of route -> controller -> service -> repository.
6. `src/modules/shopify/shopify.service.ts` — the coordinator for the important Shopify flows.
7. `prisma/models/*.prisma` — the database vocabulary.

## Running it locally

1. Use Node 22 or later (`.nvmrc` records the expected version).
2. Copy `.env.example` to `.env` and replace every placeholder secret and Shopify credential.
3. Start PostgreSQL: `npm run db:up`.
4. Apply the committed database migrations: `npm run prisma:migrate:deploy`.
5. Generate Prisma's TypeScript client: `npm run prisma:generate`.
6. Start the API in watch mode: `npm run dev`.

Useful checks:

| Command             | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `npm test`          | Run unit tests. Database tests are skipped unless `RUN_DB_TESTS=true`. |
| `npm run typecheck` | Regenerate Prisma types and check TypeScript without emitting JS.      |
| `npm run lint`      | Check code style/error-prone patterns.                                 |
| `npm run ci`        | Run schema validation, lint, typecheck, and tests in sequence.         |
| `GET /health/live`  | Confirms the HTTP process is alive.                                    |
| `GET /health/ready` | Confirms it can query PostgreSQL.                                      |

Never commit `.env`; it contains real credentials. `.env.example` documents the required names.

## How one request moves through the code

For a protected store request such as `POST /v1/stores/:storeId/integrations/shopify/sync`:

1. `app.ts` assigns a request ID, applies security/CORS/JSON/cookie middleware, and makes `req.context` available.
2. `routes.ts` sends the request to `shopifyStoreRouter`.
3. `shopify.routes.ts` runs `requireAuth`, `requireStoreMembership`, and `requireRole('OWNER', 'ADMIN')` before the controller.
4. `ShopifyController.sync` receives only trusted `req.context.storeId` and calls `ShopifyService.syncStoreData`.
5. The service gets an active connection, resolves its token, creates a `SyncRun`, and invokes catalog and inventory services.
6. Those services call Shopify through `ShopifyApiService`, validate replies with Zod, then call repositories to upsert local records.
7. The service completes or fails the `SyncRun`; the controller returns JSON.
8. Any Zod, known `AppError`, or unexpected error is formatted consistently by `error-handler.ts`.

That separation is intentional:

| Layer      | Job                                                | Should not contain          |
| ---------- | -------------------------------------------------- | --------------------------- |
| Route      | URL and reusable middleware order                  | business logic              |
| Controller | Parse HTTP inputs and return HTTP responses        | database/API implementation |
| Service    | business workflow, provider calls, error decisions | Express details             |
| Repository | Prisma reads/writes, always Store-scoped           | HTTP/business orchestration |
| Schema     | Zod validation and inferred types                  | side effects                |
| Utils      | small deterministic/reusable helpers               | feature orchestration       |

## Authentication and tenancy workflow

- Register/login create a short-lived signed **access token** and an HTTP-only **refresh-token cookie**.
- The access token includes the user's current store-role claims. `requireAuth` verifies it and puts those claims in `req.context`.
- `requireStoreMembership` selects the `:storeId` claim and adds the store ID and role to `req.context`, without an extra membership query.
- `requireRole` checks the selected role. Repositories still include `storeId` in tenant-owned queries as a second safety boundary.
- A changed membership becomes visible after a new access token is issued; the access token's 15-minute default expiry limits this delay.

## Shopify workflows

### 1. Connect a shop (OAuth)

1. Logged-in user calls `POST /v1/integrations/shopify/install` with `{ "shop": "example.myshopify.com" }`.
2. The API validates/normalizes the domain, creates a signed short-lived OAuth state cookie, and returns Shopify's authorization URL.
3. The browser follows that URL; Shopify redirects to `GET /v1/integrations/shopify/callback`.
4. The controller verifies Shopify's HMAC and callback freshness. The service verifies the state cookie, exchanges the code for expiring tokens, gets the shop profile, encrypts tokens, and creates/updates the `Store`, its OWNER membership, and its `ShopifyConnection`.
5. A scheduled reconciliation is immediately due. The user can also trigger a manual sync.

### 2. Manual catalog/inventory sync

`POST /v1/stores/:storeId/integrations/shopify/sync` (OWNER/ADMIN only) imports:

- the shop profile;
- products, then variants and inventory items;
- locations, then inventory levels for each location.

Every Shopify page is validated and saved as an `ExternalPayload` for traceability. Current local records are upserted. Records absent from a full result are soft-deleted (or, for current inventory levels, removed), so repeated syncs are idempotent.

### 3. Order-history backfill

`POST /v1/stores/:storeId/integrations/shopify/orders/backfill` starts a Shopify **Bulk Operation**, so history is not manually paged one order at a time. It responds `202` with a `syncRunId`. Query `GET .../orders/backfill/:syncRunId` until it is completed/failed. The result file is streamed JSONL, not loaded into memory. Refund line items need a focused follow-up query because Shopify bulk data does not include them completely.

### 4. Webhooks

Shopify sends `POST /v1/integrations/shopify/webhooks`. The raw body is preserved before JSON parsing, HMAC-verified, parsed, and inserted into `WebhookDelivery` with a unique Shopify webhook ID. The endpoint acknowledges only after this durable write.

`ShopifyWebhookWorker` polls the delivery queue every second. It claims a row safely, refetches current Shopify data for mutable resources, uses the ordinary persistence services, and marks the delivery processed/ignored/failed. Failures retry with exponential backoff up to five attempts. This means a slow sync never makes Shopify's HTTP delivery time out.

### 5. Periodic reconciliation

`ReconciliationWorker` polls every minute for active connections whose `nextReconciliationAt` is due. It atomically claims each connection, runs catalog/inventory reconciliation (and commerce if the connection has `read_orders`), then schedules the next one using `reconciliationIntervalMinutes`. Failed jobs are eligible again after 15 minutes; stale claims are recoverable.

## HTTP endpoint map

| Method and path                                                           | Auth                    | What it does                                |
| ------------------------------------------------------------------------- | ----------------------- | ------------------------------------------- |
| `GET /health/live`                                                        | no                      | process liveness                            |
| `GET /health/ready`                                                       | no                      | database readiness                          |
| `POST /v1/auth/register`                                                  | no                      | create a user and session                   |
| `POST /v1/auth/login`                                                     | no                      | authenticate and create a session           |
| `POST /v1/auth/refresh`                                                   | refresh cookie          | rotate refresh token and issue access token |
| `POST /v1/auth/logout`                                                    | optional refresh cookie | revoke that session and clear cookie        |
| `GET /v1/auth/me`                                                         | access token            | return current user                         |
| `GET /v1/stores`                                                          | access token            | list caller's stores                        |
| `GET /v1/stores/:storeId`                                                 | member                  | return a store and caller's role            |
| `GET /v1/stores/:storeId/integrations`                                    | member                  | Shopify/Meta connection summary             |
| `GET /v1/stores/:storeId/integrations/sync-runs`                          | member                  | recent runs; optional provider and limit    |
| `POST /v1/integrations/shopify/install`                                   | access token            | begin OAuth                                 |
| `GET /v1/integrations/shopify/callback`                                   | signed OAuth cookie     | complete OAuth and redirect to frontend     |
| `POST /v1/integrations/shopify/webhooks`                                  | Shopify HMAC            | queue a webhook delivery                    |
| `POST /v1/stores/:storeId/integrations/shopify/sync`                      | OWNER/ADMIN             | manual catalog/inventory sync               |
| `POST /v1/stores/:storeId/integrations/shopify/orders/backfill`           | OWNER/ADMIN             | start async historical order import         |
| `GET /v1/stores/:storeId/integrations/shopify/orders/backfill/:syncRunId` | OWNER/ADMIN             | inspect/finalize order import               |

## Database map

Prisma files are split by subject but loaded together from `prisma/schema.prisma`.

| Area                              | Main records                                                                                                                           | Why they exist                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Identity                          | `User`, `RefreshSession`, `StoreMembership`, `Store`                                                                                   | users, sessions, roles, and tenant boundary                                                     |
| Connections                       | `ShopifyConnection`, `MetaConnection`, `SyncRun`, `WebhookDelivery`, `ExternalPayload`                                                 | encrypted provider tokens, audit/progress trail, durable webhook inbox, raw source traceability |
| Shopify commerce                  | `Product`, `ProductVariant`, `InventoryItem`, `Location`, `InventoryLevelCurrent`, `InventorySnapshot`, `VariantOption`, `VariantCost` | catalog plus current and historical stock                                                       |
| Orders                            | `Order`, `OrderLineItem`, `Refund`, `RefundLineItem`, `Restock`, `RestockLine`                                                         | sales, returns, and future replenishment workflow                                               |
| Meta/ad model (schema only today) | `MetaAdAccount`, `MetaCampaign`, `MetaAdSet`, `MetaAd`, `MetaCreative`, catalogs, mappings, insights/actions                           | future advertising attribution and optimization data                                            |

Important distinction: `InventoryLevelCurrent` is the latest known count; `InventorySnapshot` is append-only history. `ExternalPayload` preserves the provider payload that led to a sync/backfill result.

## File-by-file reference

The list below documents files that you would normally read or edit. `node_modules/`, `src/generated/prisma/`, `dist/`, coverage output, and `package-lock.json` are generated/dependency artifacts and should not be hand-edited.

### Root and tooling

- `package.json` — project name, Node requirement, dependencies, and the commands listed above.
- `package-lock.json` — exact resolved package versions; npm maintains it.
- `.nvmrc` — preferred Node runtime version.
- `.env` — local secrets; never commit it.
- `.env.example` — complete environment-variable template. `DATABASE_URL`, JWT secrets, encryption key, Shopify app credentials/scopes/redirect/version/state secret are required.
- `.gitignore` — excludes secrets, dependencies, generated output, and local artifacts from Git.
- `.prettierrc.json` — formatting preferences.
- `eslint.config.js` — TypeScript/Node lint configuration; skips generated code.
- `tsconfig.json` — strict ESM TypeScript compilation from `src/` to `dist/`.
- `vitest.config.ts` — Node test runner setup and automatic mock restoration.
- `compose.yaml` — local PostgreSQL 17 container, persistent volume, and health check.
- `prisma.config.ts` — tells Prisma where schema/migrations live and obtains `DATABASE_URL`.
- `ARCHITECTURE.md` — authoritative engineering conventions. Read this before adding a module.
- `PROJECT_GUIDE.md` — this onboarding guide.

### Application foundation (`src/`)

- `src/server.ts` — production entry point. Starts the Express listener and both workers. `shutdown(signal)` stops accepting HTTP work, stops workers, disconnects Prisma, and force-exits after ten seconds.
- `src/app.ts` — creates Express. `createApp()` configures request IDs/logging, Helmet, CORS, JSON parsing (including Shopify raw body capture), cookies, blank request context, routes, and error handlers. `app` is the created instance used by tests/server.
- `src/routes.ts` — mounts all routers at their public prefixes; it has no business logic.
- `src/config/env.ts` — imports `.env`, validates all environment settings with `envSchema`, and exports typed `env`. Startup intentionally fails if a critical secret/configuration is absent.
- `src/lib/prisma.ts` — configures Prisma 7's PostgreSQL adapter and exports the shared `prisma` client.
- `src/lib/logger.ts` — exports Pino logger. It redacts authorization/cookie/token fields before logs leave the process.
- `src/errors/app-error.ts` — `AppError`, the expected-error class. Constructor records the safe message, HTTP status, application code, and optional details.
- `src/types/auth.ts` — type-only vocabulary: `StoreRoleClaim` and `StoreAccessClaim`.
- `src/types/express.d.ts` — extends Express `Request` with `rawBody` and trusted `context` (`userId`, selected store/role, all store claims).
- `src/routes/health.routes.ts` — health router. `/live` returns immediately; `/ready` runs `SELECT 1` first.

### Reusable middleware (`src/middleware/`)

- `auth.middleware.ts` — `requireAuth` extracts the bearer token, verifies it through `verifyAccessToken`, and writes trusted identity/claims into `req.context`.
- `store.middleware.ts` — `requireStoreMembership` validates `:storeId`, finds its claim in the verified token, and selects it into context. `requireRole(...allowedRoles)` returns middleware that permits only those roles.
- `error-handler.ts` — `notFoundHandler` emits a structured 404 for unmatched URLs. `errorHandler` converts Zod errors to 400, `AppError` to its intended response, logs unknown errors, and otherwise returns safe 500 JSON.

### Authentication module (`src/modules/auth/`)

- `auth.routes.ts` — composes `AuthRepository -> AuthService -> AuthController`; registers the five auth endpoints. Only `/me` requires `requireAuth`.
- `auth.controller.ts` — HTTP boundary. `sessionMetadata` trims the user-agent. `register`, `login`, and `refresh` parse input/cookie, call service, set refresh cookie, and return user/access token. `logout` revokes and clears cookie. `me` returns the authenticated user.
- `auth.schema.ts` — Zod schemas for registration (valid email, 10–200 character password, optional name) and login; exports inferred input types.
- `auth.service.ts` — session rules. Private `createSession` creates/hash-stores a refresh token and signs an access token. `register` normalizes email, rejects duplicates, hashes password, and creates user/session. `login` verifies credentials. `rotateRefreshSession` rejects missing/reused/expired tokens then rotates atomically. `revokeRefreshSession` invalidates a supplied token; `getCurrentUser` retrieves the user or rejects it.
- `auth.repository.ts` — Prisma access. `findUserByEmail`/`findUserById` load needed user projections; `createUser`/`createRefreshSession` write rows; `findRefreshSession` includes token-owner claims; revoke methods mark sessions invalid. `rotateSession` atomically claims the old session and writes a replacement, preventing race/reuse attacks.
- `auth.utils.ts` — security helpers. `derivePasswordKey` is private async scrypt wrapping. `hashPassword`/`verifyPassword` encode/check scrypt hashes with timing-safe comparison. Private `parseStoreAccessClaims` validates JWT claims. `issueAccessToken`/`verifyAccessToken` sign/verify the HS256 access JWT. `createRefreshToken` and `hashRefreshToken` generate/store refresh secrets safely. Private `refreshCookieOptions` centralizes secure cookie flags. `setRefreshCookie`, `clearRefreshCookie`, `sanitizeUserAgent`, `normalizeEmail`, and `refreshSessionExpiry` do exactly what their names state.

### Store module (`src/modules/stores/`)

- `store.routes.ts` — wires services, requires authentication for all routes, and uses membership middleware for `/:storeId`.
- `store.controller.ts` — `list` returns the caller's stores; `getById` returns the selected store plus role from trusted request context.
- `store.service.ts` — `listForUser` loads stores then flattens the one membership role; `getById` returns a store or a 404 `AppError`.
- `store.repository.ts` — `findMembership` is available for non-token flows; `listForUser` returns tenant summaries plus connection statuses; `findById` returns detailed store/connection fields.
- `store.schema.ts` — validates UUID `storeId` route parameters.
- `store.utils.ts` — `withMembershipRole` replaces a single-item `memberships` array with a simple `role` field for API output.

### Integration module (`src/modules/integrations/`)

- `integration.routes.ts` — store-scoped summary/history endpoints with authentication and membership middleware.
- `integration.controller.ts` — `summary` returns connection state; `syncRuns` parses query filters and returns history.
- `integration.schema.ts` — validates optional `SHOPIFY`/`META` provider and bounded history `limit`; defines `IntegrationProviderName`.
- `integration.service.ts` — common lifecycle facade shared by providers. `getSummary` validates store existence. `startSyncRun`, `attachProviderOperation`, `updateSyncRunProgress`, and `completeSyncRun` track work; `failSyncRun` formats unknown errors; getters find Shopify runs/watermarks; `recordExternalPayload` stores trace data; `listRecentSyncRuns` chooses appropriate provider connections.
- `integration.repository.ts` — persistence implementation for the service methods above: connection summaries, `SyncRun` create/update/find/list, `ExternalPayload` storage, and Store connection ID lookup.
- `integration.utils.ts` — `encryptSecret`/`decryptSecret` use AES-256-GCM with versioned envelope and authenticated associated data; startup rejects a non-32-byte key. `toErrorMessage` safely turns an unknown error into a 4,000-character max message.

### Shopify root and shared infrastructure (`src/modules/shopify/`)

- `shopify.module.ts` — composition root: creates the shared `IntegrationService`, `ShopifyService`, and `ShopifyWebhookWorker` singletons used by routes and server.
- `shopify.routes.ts` — defines unauthenticated provider callback/webhook routes and protected store sync/backfill routes. Sync/backfill require OWNER or ADMIN.
- `shopify.controller.ts` — HTTP adapter. `install` begins OAuth and writes the signed cookie. `callback` validates Shopify query HMAC/timestamp, completes OAuth, clears cookie, redirects. `webhook` queues delivery. `sync`, `startOrderBackfill`, and `getOrderBackfill` delegate their named operations.
- `shopify.service.ts` — the facade/orchestrator. `beginOAuth`, `completeOAuth`, `receiveWebhook`, and `processWebhookQueue` delegate to specialized services. `syncStoreData` runs manual shop/catalog/inventory import and completes a run. `reconcileStoreData` does scheduled import and updated-order reconciliation where authorized. `startOrderHistoryBackfill` starts a bulk run; `getOrderHistoryBackfill` polls/imports/completes it. Private `requireActiveConnection`, `hasOrderScope`, `requireOrderScope`, `historyAccess`, `buildSyncContext`, and `syncShopProfile` validate prerequisites and build reusable provider context.
- `shopify.repository.ts` — Store-scoped Shopify persistence. Private `optionalDate` and `inventoryState` normalize provider values. `connectStore` transactionally creates/updates store, membership, encrypted connection, schedule, and raw shop payload. `findConnectionForSync`, `updateConnectionTokens`, and `updateStoreProfile` manage connection/profile state. `upsertProduct`, `upsertVariant`, `upsertLocation`, `upsertInventoryLevel` save catalog data (inventory also appends a snapshot). The three `mark/deleteMissing...` methods reconcile removals. `markConnectionSynced` schedules next reconciliation; `markConnectionReauthRequired` changes status safely.
- `shopify.schema.ts` — Zod shapes for install/callback/token/profile/catalog/inventory/GraphQL responses and inferred provider types. It is the trust boundary for external Shopify JSON.
- `shopify.types.ts` — internal request/sync context, token-state, stats, and query-data types; no runtime code.
- `shopify.queries.ts` — GraphQL documents for shop profile, product/variant pages, locations, and location inventory; no executable TypeScript functions.
- `shopify.utils.ts` — provider helpers. Private `safeEqual`, `signContextPayload`, `oauthCookieOptions` support secure OAuth. `normalizeShopDomain` validates canonical `*.myshopify.com`; OAuth context creation/verification and URL/HMAC/timestamp helpers prevent callback forgery/replay. `parseRetryAfterMs`, `calculateShopifyThrottleDelayMs`, `paginateShopifyConnection`, and `sleep` implement robust GraphQL retry/pagination. Cookie setters/clearer and `buildShopifySuccessRedirect` finish browser flow.
- `shared/shopify-api.service.ts` — Shopify transport. `fetchShopProfile` runs/validates the shop query. `requestAdminGraphql` sends authenticated GraphQL requests, retries network/5xx/throttle failures, marks bad credentials for reauthorization, validates GraphQL envelope/errors, and returns typed data. Private `parseJsonResponse` turns invalid JSON into a safe provider error.
- `shared/shopify-auth.service.ts` — OAuth/token lifecycle. `beginOAuth`; `completeOAuth`; and `resolveAccessToken` (decrypt valid token or refresh it) are public. Private methods map response to plain tokens, encrypt/decrypt fields, exchange authorization code, refresh token, call Shopify token endpoint, and parse its JSON safely.

### Shopify catalog, inventory, bulk, and order features

- `catalog/shopify-catalog.queries.ts` — GraphQL documents that refetch one product and its variants after a webhook.
- `catalog/shopify-catalog.service.ts` — `sync` imports whole catalog then soft-deletes missing records. `reconcileProduct` refetches/upserts a single webhook product and returns its active variants. Private `syncProducts`/`syncVariants` page through Shopify and persist each record; `recordPagePayload` stores each raw page.
- `inventory/shopify-inventory.queries.ts` — GraphQL documents for one location and one inventory item/location level after a webhook.
- `inventory/shopify-inventory.service.ts` — `sync` imports locations then levels per location, including snapshots. `reconcileLocation` and `reconcileInventoryLevel` refetch/update one webhook resource. Private `syncLocations`, `syncLocationInventory`, `assertInventoryQuantities`, and `recordPagePayload` paginate, verify all eight quantity states exist, reconcile missing levels, and keep raw pages.
- `bulk/shopify-bulk.queries.ts` — GraphQL mutation/query documents to start and inspect Shopify bulk work.
- `bulk/shopify-bulk.schema.ts` — Zod validators/types for bulk start/status replies.
- `bulk/shopify-bulk.service.ts` — `startQuery` starts a validated Shopify bulk query; `getStatus` validates status and IDs; `streamJsonl` downloads and yields result rows incrementally. Private `parseJsonlLine` reports malformed streamed JSON safely.
- `order/shopify-order.queries.ts` — bulk history query plus focused updated-order, order-detail, and refund-detail documents.
- `order/shopify-order.schema.ts` — Zod validation for monetary values, order/refund/line rows, pages, and backfill route parameter; exports the inferred types.
- `order/shopify-order.types.ts` — compile-time contracts for query data, imported/persisted orders, backfill results, and inspection states.
- `order/shopify-order.repository.ts` — database writer for commerce. Private `optionalDate`, `moneyAmount`, `asJson`, and `uniqueIds` normalize values. `upsertOrderWithLineItems` transactionally upserts an order and links known catalog records. `upsertRefundWithLineItems` verifies references, upserts refund header, replaces refund lines, and links locations when known. Private `orderData`, `lineItemData`, and `refundData` map provider shapes to Prisma data.
- `order/shopify-order.service.ts` — commerce importer. `startBulkBackfill` begins export. `inspectBulkBackfill` checks operation and imports completed output. `reconcileUpdatedOrders` finds changed orders with an overlap window. `reconcileOrder` fetches all item pages for one order. Private `importBulkResult` streams/validates parent-child JSONL rows, `persistOrder` writes order plus hydrated refunds/counts, `loadRefund` paginates refund lines, and `emptyResult` initializes counters.

### Shopify webhook feature (`src/modules/shopify/webhook/`)

- `shopify-webhook.schema.ts` — validates mandatory delivery headers and the minimal relevant fields for resource, refund, inventory, and bulk-completion payloads.
- `shopify-webhook.utils.ts` — `verifyShopifyWebhookHmac` authenticates the exact raw body with timing-safe comparison; `parseShopifyWebhookJson` validates JSON; `shopifyGid` converts numeric IDs to Shopify GraphQL global IDs.
- `shopify-webhook.repository.ts` — durable inbox and cleanup writes. Finds connections; `createDelivery` deduplicates safely; `listDueDeliveryIds`/`tryClaim` implement retry-safe work claiming; getters/status methods manage deliveries. Remaining methods mark uninstall/product/variant/location deletes, remove current levels/orders, and find a backfill by provider operation ID.
- `shopify-webhook.service.ts` — webhook workflow. `receive` validates headers/HMAC/body then durably queues delivery. `processDueDeliveries` claims due rows and retries failures. Private `processClaimedDelivery` loads connection/token and chooses processed/ignored behavior. Private `dispatch` routes each topic to targeted catalog/inventory/order reconciliation or deletion. Private `finishOrderHistoryBackfill` converts Shopify bulk completion into a completed/failed `SyncRun` plus trace payload.
- `shopify-webhook.worker.ts` — polling worker. `start` schedules one-second ticks; `stop` waits for an in-flight tick; private `tick` prevents overlapping batches, calls queue processing, and logs failures.

### Scheduled reconciliation (`src/modules/reconciliation/`)

- `reconciliation.module.ts` — creates one repository/service/worker around the shared Shopify service.
- `reconciliation.repository.ts` — `listDueShopifyConnectionIds` finds active, due, unclaimed/stale connections; `tryClaimShopify` atomically claims and returns Store ID; `markShopifyFailed` clears claim and schedules retry.
- `reconciliation.service.ts` — `processDue` claims up to ten connections, calls `ShopifyService.reconcileStoreData`, and counts successes/failures. Claim expiry is 30 minutes; failed work retries after 15 minutes.
- `reconciliation.worker.ts` — `start` runs immediately and every minute; `stop` clears timer/waits; private `tick` prevents overlaps, invokes `processDue`, and logs results/errors.

### Prisma schema and migration files (`prisma/`)

- `schema.prisma` — Prisma generator and PostgreSQL datasource declaration. It points generated client code at `src/generated/prisma`.
- `models/core.prisma` — `User`, `RefreshSession`, `StoreMembership`, and `Store` models/roles.
- `models/integrations.prisma` — provider connections, sync state, durable webhooks, and captured source payloads.
- `models/shopify.prisma` — products, variants/options/costs, inventory items/locations/current levels/history snapshots.
- `models/orders.prisma` — orders, lines, refunds, refund lines, restocks.
- `models/meta.prisma` — the planned Meta Ads/campaign/catalog/insight/attribution data model. There is no Meta API module yet.
- `migrations/migration_lock.toml` — tells Prisma this migration history targets PostgreSQL.
- `migrations/*/migration.sql` — immutable, ordered history of database changes. The directory names describe each change: core, integrations, Shopify, orders, Meta, expiring Shopify tokens, nullable refund date, source metadata, provider-operation tracking, webhook queue, and reconciliation scheduling. Create new migrations through Prisma; do not edit committed migrations.

### Tests (`tests/`)

- `tests/setup.ts` — supplies safe default test environment variables before modules import `env`.
- `tests/app.test.ts` — checks liveness endpoint/request ID and structured 404 handling.
- `tests/database.test.ts` — optional (`RUN_DB_TESTS=true`) real-database readiness and essential-table checks.
- `tests/modules/auth/auth.utils.test.ts` — tests password, JWT, refresh-token, cookie, and auth helper behavior.
- `tests/modules/integrations/integration.utils.test.ts` — tests encryption/decryption and error-message behavior.
- `tests/modules/reconciliation/reconciliation.repository.test.ts` — tests scheduled connection lookup/claim/retry database behavior.
- `tests/modules/reconciliation/reconciliation.service.test.ts` — tests due-job orchestration and success/failure accounting.
- `tests/modules/shopify/shopify.utils.test.ts` — tests domain, OAuth, HMAC, retry, pagination, and redirect helpers.
- `tests/modules/shopify/shopify.service.test.ts` — tests facade manual sync/OAuth/backfill orchestration.
- `tests/modules/shopify/shopify-layout.test.ts` — protects the intended Shopify feature-folder/module layout.
- `tests/modules/shopify/shopify-bulk.service.test.ts` — tests bulk start/status/JSONL stream error handling.
- `tests/modules/shopify/shopify-catalog-reconciliation.test.ts` — tests catalog sync/reconciliation/deletion behavior.
- `tests/modules/shopify/shopify-inventory-reconciliation.test.ts` — tests inventory quantities, snapshots, and reconciliation behavior.
- `tests/modules/shopify/shopify-order.service.test.ts` — tests order import/reconciliation logic.
- `tests/modules/shopify/shopify-order.repository.test.ts` — tests transaction mapping/upserts for orders/refunds.
- `tests/modules/shopify/shopify-order-facade.test.ts` — tests root service's order-backfill endpoint-facing behavior.
- `tests/modules/shopify/shopify-order-watermark.test.ts` — verifies overlapping "since" watermark reconciliation logic.
- `tests/modules/shopify/shopify-order-reconciliation.test.ts` — checks changed-order scan/reconciliation handling.
- `tests/modules/shopify/shopify-webhook.utils.test.ts` — tests raw-body HMAC/JSON/GID helpers.
- `tests/modules/shopify/shopify-webhook.repository.test.ts` — tests inbox dedupe, claiming, retries, and deletion persistence.
- `tests/modules/shopify/shopify-webhook.service.test.ts` — tests receipt, dispatch, and completion workflow.

## A safe way to make a change

For a new provider-backed capability, follow the existing pattern:

1. Add/alter Prisma model and create a new migration.
2. Add Zod input/provider schemas and TypeScript types.
3. Put external GraphQL documents in a focused `*.queries.ts` file.
4. Add Store-scoped repository operations.
5. Add service orchestration and idempotency/error handling.
6. Add controller + route with the appropriate auth/store/role middleware.
7. Add focused tests and run `npm run ci`.

Keep OAuth token handling, shared Shopify transport behavior, and `SyncRun`/`ExternalPayload` ownership in the existing shared services unless the design genuinely requires a new shared abstraction.
