# Stride V1 production rollout runbook

This is the operator checklist for moving the current Stride V1 implementation from merged code to a validated merchant/test-store deployment.

It consolidates the process topology, Shopify privacy, Shopify validation, Pixel runtime, and analytics performance requirements into one execution order. It does not expand V1 scope or weaken Stride's data-truth boundaries.

## V1 truth boundaries

- Shopify is commerce truth.
- Meta metrics remain provider-attributed advertising evidence.
- Product × Ads mapping/shared exposure is deterministic cross-channel evidence.
- Stride Pixel is first-party observed behavior and journey evidence.
- Inventory-driven recommendations require `TRUSTED` inventory mode.
- No V1 causal incrementality/MMM/forecast/autonomous ad mutation is implied by this rollout.

## 1. Freeze the release revision

Before provisioning production/test-store runtime:

1. confirm backend `main` and frontend `main` are the intended revisions;
2. require green repository CI for both revisions;
3. record the backend and frontend commit SHAs in the rollout notes;
4. do not test a frontend preview against a different backend revision and treat that as release validation.

If the deployment provider rate-limits a build, the Git revision is still merged but **not deployed**. Verify the live deployment revision explicitly before continuing.

## 2. Backend process topology

Use the same backend revision and environment for both processes.

### API process

```bash
npm ci
npm run build
npm run prisma:migrate:deploy
npm start
```

Health checks:

```text
GET /health/live
GET /health/ready
```

`/health/ready` must confirm PostgreSQL connectivity before traffic is considered ready.

### Persistent worker process

Run exactly one worker replica for initial merchant testing:

```bash
npm run start:worker
```

Do **not** rely on a Vercel request function as the only worker runtime. The worker must remain alive to drain:

- Shopify webhook queue;
- TikTok webhook queue when configured;
- scheduled reconciliation;
- Pixel session/journey repair;
- Pixel behavior rollups;
- Pixel attribution rollups;
- Pixel retention cleanup.

Do not increase worker replicas until claim/lease behavior has been deliberately load-tested.

## 3. Required backend environment

The API and worker must share the same values for all data/integration secrets and point at the same PostgreSQL database.

At minimum verify production values for:

```text
NODE_ENV=production
APP_URL=<public backend origin>
DATABASE_URL=<production/test database>
CORS_ORIGIN=<frontend origin>
JWT_ACCESS_SECRET=<secret>
TOKEN_ENCRYPTION_KEY=<secret>
REDIS_REST_URL=<redis REST endpoint>
REDIS_REST_TOKEN=<secret>
RESEND_API_KEY=<secret>
RESEND_FROM=<verified sender>
SHOPIFY_CLIENT_ID=<existing app client id>
SHOPIFY_CLIENT_SECRET=<secret>
SHOPIFY_STATE_SECRET=<secret>
SHOPIFY_API_VERSION=2026-07
META_APP_ID=<meta app id>
META_APP_SECRET=<secret>
META_STATE_SECRET=<secret>
META_API_VERSION=v26.0
PIXEL_RAW_EVENT_RETENTION_DAYS=90
```

Do not paste secret values into rollout notes, GitHub issues, benchmark output, or chat transcripts.

Expected Shopify scopes include:

```text
read_products
read_inventory
read_locations
read_orders
write_pixels
read_pixels
read_customer_events
```

During performance profiling only, temporarily enable:

```text
LOG_REQUEST_PERFORMANCE=true
```

Return it to the normal production setting after measurement unless continuous verbose request profiling is intentionally desired.

## 4. Shopify app configuration and Web Pixel extension

The backend repository intentionally does not contain a fabricated Shopify Web Pixel UID. Generate the real extension inside a Shopify CLI app project linked to the existing Stride app.

### Link the CLI project to the existing app

From a Shopify CLI app project:

```bash
shopify app config link
```

For a non-interactive flow, use the app's real client ID rather than inventing another app:

```bash
shopify app config link --client-id <client-id>
```

Inspect the pulled/generated `shopify.app.toml` before deploying. Do not overwrite Dashboard-managed settings blindly.

### Mandatory compliance subscriptions

The released app configuration must contain:

```toml
[[webhooks.subscriptions]]
uri = "/v1/integrations/shopify/webhooks"
compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]

[[webhooks.subscriptions]]
uri = "/v1/integrations/shopify/webhooks"
topics = ["app/uninstalled"]
```

### Generate the real Web Pixel extension

```bash
shopify app generate extension --template web_pixel --name stride-pixel
```

Then:

1. preserve the Shopify-generated `uid` in the generated `shopify.extension.toml`;
2. replace the generated extension `src/index.js` with `extensions/stride-pixel/src/index.js` from this repository;
3. copy the privacy/settings declarations from `extensions/stride-pixel/shopify.extension.toml.template` without replacing the generated UID;
4. verify the extension still requests analytics-only customer privacy behavior as defined by Stride.

Validate the app configuration:

```bash
shopify app config validate
```

For the safest first production-shaped check, create a version without releasing it:

```bash
shopify app deploy --no-release
```

Inspect the generated app version in the Dev Dashboard. Release only after the scopes, compliance subscriptions, extension UID/config, and app URLs are correct.

If the test store was installed before Pixel scopes were added, reauthorize/reinstall it so Shopify grants the current scopes.

## 5. Install and verify Stride Pixel

After the backend revision containing Pixel support is live and the Shopify app version containing the extension is released:

1. authenticate as the test-store OWNER/ADMIN;
2. install/rotate the Pixel:

```text
POST /v1/stores/:storeId/pixel/install
```

3. confirm installation state:

```text
GET /v1/stores/:storeId/pixel/status
```

Expected result: installation is `ACTIVE`, a Shopify provider pixel ID is present, and no raw collector token is exposed.

4. when the operational-health revision is deployed, inspect:

```text
GET /v1/stores/:storeId/pixel/health
```

The health response reports evidence; it intentionally does not invent universal pass/fail thresholds before real rollout data exists.

## 6. Real storefront Pixel journey

Use the connected development/test store and execute a traceable journey:

```text
page view
→ product view
→ collection view where relevant
→ add to cart
→ cart view
→ checkout start/progression
→ checkout completed
→ Shopify order ingestion
→ pending order link
→ exact Shopify order link
→ behavior rollup
→ attribution rollup
→ mapping evidence
```

Verify all of the following:

- raw event URLs contain no query strings/fragments/credentials;
- duplicate delivery of the same `(storeId,eventId)` creates no duplicate row;
- denied/unknown analytics consent persists no behavioral event;
- checkout completion alone does not create Shopify revenue truth;
- the materialized session links to the real reconciled Shopify Order;
- late Shopify order arrival eventually links a previously pending session;
- Meta source resolution changes can repair/recompute affected evidence;
- behavior and attribution rollups drain after the worker runs;
- Product × Ads evidence never fabricates equal shared-spend allocation;
- Pixel evidence does not bypass the existing automatic exact-mapping threshold.

Use `GET /pixel/health` and worker logs while performing this flow. A persistent backlog that does not drain is a rollout blocker.

## 7. Shopify commerce/reconciliation validation

Exercise the cases in `docs/SHOPIFY_VALIDATION_MATRIX.md`, especially:

- normal vs test order exclusion;
- imported historical order date semantics;
- refund subtraction;
- cancellation state;
- tracked vs untracked inventory;
- zero/low stock;
- multi-location inventory;
- missed-change repair through scheduled reconciliation.

Do not treat a successful OAuth connection as sufficient validation of the commerce read model.

## 8. Shopify privacy/compliance validation

Use a disposable test store for destructive checks. Follow `docs/SHOPIFY_PRIVACY_COMPLIANCE.md` and verify at minimum:

1. signed fixture deliveries for `customers/data_request`, `customers/redact`, and `shop/redact` are acknowledged and processed asynchronously;
2. durable webhook storage never retains supplied customer email/phone values;
3. OWNER/ADMIN can retrieve the generated data request and MEMBER cannot;
4. customer redaction removes order-linked raw/session evidence and overlapping export data;
5. the order-redaction tombstone prevents a later backfill/reconciliation from resurrecting the order;
6. redaction still works after `app/uninstalled` makes the Shopify connection inactive;
7. a retry after destructive work but before final delivery-status transition is replay-safe;
8. `shop/redact` removes only the disposable tenant graph and does not affect another store.

## 9. Browser request-budget validation

On the merged frontend revision, verify the production browser still respects the budgets covered by Playwright:

- Advertising initial business data: one request;
- Advertising Refresh: one request;
- Overview initial business data: one `/analytics/dashboard` request;
- Overview Refresh: one `/analytics/dashboard?fresh=true` request;
- normal data Refresh does not rotate refresh-session credentials while the access JWT is fresh;
- TikTok monitor does not walk the advertiser's full paginated history automatically.

Use the browser Network panel against the real backend, not only mocked E2E tests.

## 10. Real-store analytics performance benchmark

Run this only against a test store whose Shopify/Meta data is representative enough to exercise the hot SQL paths.

In the backend runtime temporarily enable:

```text
LOG_REQUEST_PERFORMANCE=true
```

From a trusted local shell with a fresh access token:

```powershell
$env:BASE_URL="https://<backend-api-host>"
$env:STORE_ID="<store-uuid>"
$env:ACCESS_TOKEN="<fresh-access-jwt>"
$env:BENCHMARK_ITERATIONS="20"
$env:BENCHMARK_WARMUPS="3"
npm run perf:analytics
```

Do not commit, paste publicly, or store the access token in shell history that will be shared.

Capture for each endpoint:

- median latency;
- p95 latency;
- Prisma query count;
- Prisma DB wall time;
- slowest query names/durations;
- response bytes.

Prioritize forced-refresh measurements in this order:

1. Intelligence;
2. Dashboard;
3. TikTok monitor when configured.

Measure warm-cache reads separately. Warm-cache success must not be used to hide an expensive source query.

Only after the real query plan identifies a bottleneck should another index/query rewrite be introduced. In particular, do not duplicate/replace the current Meta insight composite index merely because `(adAccountId, level, date)` looks attractive statically; validate the hot query with `EXPLAIN (ANALYZE, BUFFERS)` first.

## 11. Release acceptance criteria

The V1 rollout is ready to move from engineering validation to controlled merchant testing only when:

- the intended frontend and backend commits are actually deployed;
- API liveness/readiness pass;
- exactly one persistent worker replica is running and backlogs drain;
- the released Shopify app version contains the required scopes, compliance webhooks, and real Web Pixel extension UID;
- Pixel install/status and a full real storefront journey pass;
- consent, duplicate, late-event, late-order-link, and resolution-repair cases pass;
- Shopify validation-matrix and privacy destructive tests pass on disposable data;
- browser request budgets hold against the real backend;
- real-store performance measurements are captured and no known critical bottleneck is being hidden by cache;
- deterministic recommendations still expose evidence/limitations/data quality and respect V1 truth boundaries.

## 12. Rollback / stop conditions

Stop merchant testing and rollback the affected deployment/app version if any of the following occurs:

- Shopify commerce truth is materially wrong or cross-currency data is silently mixed;
- privacy redaction can resurrect data or erase another tenant;
- denied consent persists behavioral evidence;
- Pixel collector credentials leak in an API response or logs;
- the persistent worker cannot drain queues/reconciliation/rollups;
- a provider write occurs outside an explicitly authorized setup action;
- frontend/browser fan-out returns to an unbounded provider-history walk;
- performance is acceptable only because stale/warm cache masks an expensive source read.

After rollback, preserve the failing test-store evidence and request/query timings needed to reproduce the defect, without preserving customer secrets or raw collector credentials.
