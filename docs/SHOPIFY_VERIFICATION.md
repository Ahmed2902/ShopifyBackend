# Shopify verification runbook

This runbook is the final provider-side check after the deterministic CI suite passes. CI uses mocked Shopify HTTP responses with real PostgreSQL persistence; this runbook validates the same flows against a real Shopify development store.

## Safety

- Use a Shopify development store, never a merchant production store.
- Keep `NODE_ENV=development` or `test`; the live verification script refuses to run in production.
- Do not paste access or refresh tokens into logs, issues, or PR comments. The script reads the encrypted connection already stored by the application and only prints normalized sync/read status.
- Run database migrations before verification.

## Automated live smoke check

After installing the app through the normal OAuth flow and refreshing the app access token so the new Store membership is present, set:

```bash
SHOPIFY_VERIFY_STORE_ID=<internal Store UUID>
```

Then run:

```bash
npm run shopify:verify-live
```

The command performs:

1. current integration/data status read;
2. full shop/catalog/inventory sync;
3. periodic-style reconciliation;
4. final normalized status read.

Historical order import is deliberately opt-in because it starts a Shopify Bulk Operation:

```bash
SHOPIFY_VERIFY_BACKFILL=true npm run shopify:verify-live
```

`SHOPIFY_VERIFY_BACKFILL_TIMEOUT_MS` can override the default 30-minute polling timeout.

## Full development-store lifecycle

Use one product with at least two variants and one active inventory location. Record the internal Store UUID before starting.

### 1. OAuth and credential rotation

1. Install the app through `/v1/integrations/shopify/install` and the Shopify callback.
2. Refresh the application access token after the callback so the Store membership claim is current.
3. Confirm `/v1/stores/:storeId/integrations/shopify/status` reports an ACTIVE connection.
4. Set the stored access token close enough to expiry in a development database, or wait for the normal refresh window, then trigger two overlapping operations (for example a manual sync and reconciliation).
5. Confirm both operations succeed, only one Shopify refresh rotation is persisted, `refreshClaimedAt` returns to null, and the connection remains ACTIVE.

Expected failure behavior: an actually expired/rejected refresh token changes the connection to `REAUTH_REQUIRED`; network/5xx failures release the refresh claim and do not falsely require merchant reauthorization.

### 2. Initial catalog and inventory

Run the live smoke command or call the manual sync endpoint. Verify:

- Store profile matches the development store;
- products and variants exist exactly once;
- selected options are normalized;
- inventory items and locations match Shopify;
- all eight inventory states are present when Shopify supplies them;
- current inventory is correct and an `INITIAL_SYNC`/manual snapshot is appended;
- repeating the sync does not duplicate products, variants, locations, or current inventory rows.

### 3. Historical orders and refunds

Enable `SHOPIFY_VERIFY_BACKFILL=true` or start the backfill endpoint and poll its status endpoint.

Create test data first if necessary using Shopify development-store test orders. Include at least:

- one normal order with multiple line items;
- one order containing a discount;
- one partial refund;
- one full refund if practical;
- one custom/deleted product line if practical.

Verify:

- one Bulk Operation imports order headers and line items;
- discovered historical refund IDs are hydrated through the focused Refund query;
- order, line-item, refund, and refund-line persistence is idempotent;
- rerunning/reconciling does not duplicate rows;
- the status endpoint accurately reports `LAST_60_DAYS` unless the app has approved `read_all_orders` access.

### 4. Operational webhooks

Perform these changes in Shopify and allow the webhook worker to process them:

- create/update a product;
- remove a variant from a product;
- delete a product;
- change inventory;
- disconnect/reconnect an inventory level if available;
- create/update a test order;
- create a refund;
- deactivate/reactivate a location if practical.

For each event verify the corresponding `WebhookDelivery` reaches `PROCESSED`, duplicate delivery IDs do not cause duplicate work, and the normalized read endpoints reflect the new state.

### 5. Reconciliation repair

Temporarily stop the API/worker, make several Shopify changes, then restart without manually replaying webhooks. Wait until the Store is due or trigger `reconcileStoreData` through the verification script.

Verify reconciliation repairs:

- catalog changes and missed deletions;
- location/current inventory drift;
- inventory snapshots with `PERIODIC_RECONCILIATION` source;
- orders/refunds updated since the previous successful reconciliation, including the five-minute overlap window.

A manual catalog/inventory sync must not advance the commerce watermark. The incremental order query should use the last successful `StoreReconciliation` SyncRun.

### 6. Frontend read contract

Check the Store-scoped endpoints used by the frontend:

- `/status`
- `/products`
- `/products/:productId`
- `/inventory`
- `/locations`
- `/orders`
- `/orders/:orderId`

Verify pagination and filters, MEMBER read access, OWNER/ADMIN-only sync/backfill writes, hidden-store 404 behavior, and absence of provider `rawJson`, credentials, or customer PII in responses.

### 7. Uninstall

Uninstall the app from the development store and verify the `app/uninstalled` delivery marks the Shopify connection `UNINSTALLED`. Background work should stop treating that connection as ACTIVE.

## Sign-off

Do not call Shopify provider integration production-verified until all of the following are true:

- full CI is green with PostgreSQL tests;
- this live smoke command passes;
- historical import is verified against at least one test order/refund;
- at least one product and one inventory webhook have been observed end-to-end;
- missed-event reconciliation has been demonstrated;
- uninstall transitions the connection out of ACTIVE state.
