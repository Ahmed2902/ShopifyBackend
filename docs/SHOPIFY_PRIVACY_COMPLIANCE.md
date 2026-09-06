# Shopify privacy and compliance webhooks

Stride receives Shopify webhooks at:

```text
POST /v1/integrations/shopify/webhooks
```

The same endpoint handles operational Shopify webhooks and Shopify's mandatory privacy/compliance topics. Every request is authenticated against the exact raw request body using `X-Shopify-Hmac-Sha256`, durably deduplicated by `X-Shopify-Webhook-Id`, and processed asynchronously by the Shopify webhook worker.

## Required compliance topics

The Shopify app configuration must subscribe to:

```toml
[[webhooks.subscriptions]]
uri = "/v1/integrations/shopify/webhooks"
compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
```

The app should also subscribe to uninstall notifications:

```toml
[[webhooks.subscriptions]]
uri = "/v1/integrations/shopify/webhooks"
topics = ["app/uninstalled"]
```

Do not release a new Shopify app version until the local app configuration has been pulled/validated against the active Dashboard version. App version deployment is separate from deploying the Stride API.

## Data minimization at ingress

Shopify compliance payloads can contain customer email and phone values. Stride validates the original signed payload and then removes customer email, phone, and customer ID before writing the durable webhook inbox.

The inbox retains only what Stride needs to execute the request:

- shop identity
- Shopify order IDs supplied by Shopify for customer data access/redaction
- Shopify data-request ID when present

After processing, the webhook payload is scrubbed again to a minimal completion audit. That completion audit is also a replay marker: if destructive work commits and the worker dies before the delivery status is updated, a retry recognizes the already-completed payload instead of re-parsing it as the original Shopify request.

## `customers/data_request`

Stride does not ingest a Shopify customer profile or customer email/phone into its commerce read model. It does retain order records and privacy-safe storefront journey evidence that can become customer-linked when a checkout is linked to an order.

When Shopify sends a data request, Stride generates an export containing the retained fields for the matching imported orders together with linked raw storefront events, materialized sessions, product/collection session evidence, and outstanding session-repair evidence. OWNER/ADMIN users can retrieve generated exports through:

```text
GET /v1/stores/:storeId/integrations/shopify/privacy/data-requests
GET /v1/stores/:storeId/integrations/shopify/privacy/data-requests/:requestId
```

Exports are tenant-scoped and inaccessible to MEMBER users.

## `customers/redact`

Customer redaction irreversibly removes:

- imported Shopify orders listed in `orders_to_redact`
- refund and line-item rows belonging to those orders
- raw Stride Pixel events linked directly or through the same browser sessions
- linked materialized storefront sessions and session repair rows
- any generated Shopify data-request export that overlaps the redacted order IDs
- customer-bearing historical Shopify order/refund webhook payloads associated with those orders

Before removing the imported order, Stride persists a tenant-scoped `ShopifyOrderRedaction` tombstone. Shopify webhook reconciliation, scheduled reconciliation, and historical/bulk order import all consult that tombstone, so a late provider event cannot resurrect a redacted order after erasure.

Aggregate behavior/attribution rollups are not customer-identified and are retained as anonymous aggregate statistics.

The redaction path does not require a usable Shopify access token and continues to run after `app/uninstalled` has marked the connection inactive.

## `shop/redact`

Shop redaction erases the whole tenant graph, including:

- Shopify commerce/catalog/inventory data
- Meta and TikTok provider data associated with the tenant
- provider mapping and insight data
- sync runs, old webhook deliveries, and raw external payloads
- generated Shopify data-request exports and order-redaction tombstones
- Stride Pixel raw/read-model data
- store memberships and the Store record
- encrypted provider connections

The current `shop/redact` delivery survives only as a scrubbed, provider-connection-detached completion audit so the worker can atomically mark the authenticated request processed. It contains no merchant payload data after erasure.

The purge uses an extended interactive-transaction timeout appropriate for the multi-table tenant erase and intentionally fails closed if a future restrictive database relation is added without a corresponding erasure step.

## Operational verification before App Store submission

Before public submission, verify all of the following against a disposable Shopify test store:

1. Send signed fixture deliveries for all three compliance topics and verify HTTP acknowledgment plus asynchronous processing.
2. Confirm the durable inbox never contains supplied customer email/phone values.
3. Generate a customer data request and retrieve it as OWNER/ADMIN; verify MEMBER is rejected and all retained customer-linked evidence is represented.
4. Redact the same customer and confirm the order, raw Pixel browser session, historical order/refund webhook evidence, and data-request export disappear.
5. Attempt a later Shopify order reconcile/backfill for the redacted order and confirm the tombstone prevents re-import.
6. Uninstall the app, then process customer/shop redaction while the connection is no longer ACTIVE.
7. Simulate a worker retry after the privacy operation committed but before delivery status transition; confirm the scrubbed completion marker is replay-safe.
8. Run `shop/redact` only against a disposable store and confirm all tenant/provider data is gone while other stores remain intact.
9. Pull/validate the Shopify app configuration and confirm the active/released version contains the compliance subscriptions before production review.
