# Shopify privacy and compliance webhooks

Metrico receives Shopify webhooks at:

```text
POST /v1/integrations/shopify/webhooks
```

The same endpoint handles operational Shopify webhooks and Shopify's mandatory privacy/compliance topics. Every request is authenticated against the exact raw request body using `X-Shopify-Hmac-Sha256`, durably deduplicated by `X-Shopify-Webhook-Id`, and processed asynchronously by the Shopify webhook worker.

## Required compliance topics

The Shopify app configuration must subscribe to:

```toml
[[webhooks.subscriptions]]
uri = "https://YOUR_BACKEND_HOST/v1/integrations/shopify/webhooks"
compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]
```

The app should also subscribe to uninstall notifications:

```toml
[[webhooks.subscriptions]]
uri = "https://YOUR_BACKEND_HOST/v1/integrations/shopify/webhooks"
topics = ["app/uninstalled"]
```

Do not release a new Shopify app version until the local app configuration has been pulled/validated against the active Dashboard version. App version deployment is separate from deploying the Metrico API.

## Data minimization at ingress

Shopify compliance payloads can contain customer email and phone values. Metrico validates the original signed payload and then removes customer email, phone, and customer ID before writing the durable webhook inbox.

The inbox retains only what Metrico needs to execute the request:

- shop identity
- Shopify order IDs supplied by Shopify for customer data access/redaction
- Shopify data-request ID when present

After processing, the webhook payload is scrubbed again to a minimal completion audit. That completion audit is also a replay marker: if destructive work commits and the worker dies before the delivery status is updated, a retry recognizes the already-completed payload instead of re-parsing it as the original Shopify request.

## `customers/data_request`

Metrico does not ingest a Shopify customer profile or customer email/phone into its commerce read model. It does retain order records and privacy-safe storefront journey evidence that can become customer-linked when a checkout is linked to an order.

When Shopify sends a data request, Metrico generates an export containing the retained fields for the matching imported orders together with linked raw storefront events, materialized sessions, product/collection session evidence, outstanding session-repair evidence, minimal consent-withdrawal cutoffs, order-linked customer pseudonyms and conversion-delivery records. Destination secrets are excluded. Export creation takes a shared connection lock so it cannot recreate erased data after concurrent redaction. OWNER/ADMIN users can retrieve generated exports through:

```text
GET /v1/stores/:storeId/integrations/shopify/privacy/data-requests
GET /v1/stores/:storeId/integrations/shopify/privacy/data-requests/:requestId
```

Exports are tenant-scoped and inaccessible to MEMBER users.

## `customers/redact`

Customer redaction irreversibly removes:

- imported Shopify orders listed in `orders_to_redact`
- refund and line-item rows belonging to those orders
- raw Metrico Pixel events linked directly or through the same browser sessions
- linked materialized storefront sessions and session repair rows
- order-linked customer pseudonyms and conversion-delivery records
- any generated Shopify data-request export that overlaps the redacted order IDs
- customer-bearing historical Shopify order/refund webhook payloads associated with those orders

Before removing the imported order, Metrico persists a tenant-scoped `ShopifyOrderRedaction` tombstone. Shopify webhook reconciliation, scheduled reconciliation, and historical/bulk order import all consult that tombstone, so a late provider event cannot resurrect a redacted order after erasure.

Aggregate behavior/attribution rollups are not customer-identified and are retained as anonymous aggregate statistics.

The redaction path does not require a usable Shopify access token and continues to run after `app/uninstalled` has marked the connection inactive.

## `shop/redact`

Shop redaction erases the whole tenant graph, including:

- Shopify commerce/catalog/inventory data
- Meta, TikTok and Google Ads provider data associated with the tenant
- provider mapping and insight data
- sync runs, old webhook deliveries, and raw external payloads
- generated Shopify data-request exports and order-redaction tombstones
- Metrico Pixel raw/read-model data
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


## Advertising disclosure permission

Analytics permission alone does not authorize sending purchases to Meta, TikTok or Google Ads. The updated pixel uses Shopify Customer Privacy `analyticsProcessingAllowed`, `marketingAllowed` and `saleOfDataAllowed`; all three must be true for `adSharingAllowed`. Missing permission (including older pixel clients and historical rows) defaults to false. The extension declaration must match these purposes. Revoking analytics clears queued pixel events; revoking marketing removes queued sharing permission.

Candidates and claimed retries require retained permitted attribution and the latest recorded visitor/session permission immediately before delivery. Every provider awaits a final durable permission check after credential preparation, including Google OAuth refresh, before starting its HTTP request. If either is unavailable the queued disclosure is discarded and its identifiers cleared. Already delivered conversions cannot be recalled by this local gate: customer erasure must include the provider's applicable deletion/support process. Verify consent transitions in the live storefront before submission.


### Durable privacy-only revocation

The Pixel sends `events: []` plus a minimal `withdrawal` visitor/session identifier to the existing authenticated `/v1/pixel/events` collector. This remains a privacy operation when analytics permission is absent, and contains no page/click/checkout payload. Recently captured privacy subjects survive page reload and checkout-session clearing so no new behavior event is required to identify the withdrawal.

`StorefrontConsentWithdrawal` is store-scoped and records only scope identity, a monotonic revocation cutoff and expiration. The cutoff includes the accepted ten-minute future-clock window to cover old in-flight events. Withdrawal downgrades retained source permission; ingress and all provider candidate/delivery checks consult durable markers. A later regrant does not authorize an old source or an advertising click after the purchase. New events beyond the cutoff can support new purchases.

Markers are included in related privacy exports and remain until normal expiry after matching customer redaction, so an older in-flight batch cannot restore advertising permission. They cascade on shop purge. Customer redaction locks the connection against Pixel insertion and export creation. Bounded cleanup retains them for at least 40 days or the longer configured raw-event period. Live consent verification must check collector acknowledgment; bounded browser retries are not a guarantee when the client stays offline.
