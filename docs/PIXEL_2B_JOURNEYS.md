# PIXEL-2B — Session and journey read model

PIXEL-2B turns privacy-minimized raw Stride Pixel events into a deterministic read model for storefront sessions, observed traffic touches, product/collection interactions, and exact Shopify order linkage.

## Truth boundaries

Stride keeps three evidence layers separate:

- Shopify is commerce truth: orders, revenue, refunds, catalog and inventory.
- Advertising providers are provider-attributed advertising evidence.
- Stride Pixel is observed first-party storefront behavior.

A Pixel touch saying `metaAdExternalId = 123` means that the storefront visit carried Meta Ad `123` as observed tracking evidence. It does not mean the ad causally caused a purchase.

## Session identity

The Shopify Web Pixel already emits an opaque browser session ID. PIXEL-2B materializes events with the same `(storeId, sessionId)` into one `StorefrontSession`.

The session stores only privacy-minimized behavioral state:

- opaque anonymous visitor ID
- session start/end
- event counts
- checkout progression
- sanitized landing/referrer URLs
- ordered acquisition touches
- resolved product/variant/collection pointers
- optional exact Shopify order pointer
- explicit data-quality flags

No email, phone, postal address, raw IP, fingerprint, payment information or checkout monetary values are added.

## Ordered touch history

PIXEL-2A introduced exact provider IDs in landing parameters. PIXEL-2B preserves changes in that attribution context rather than replacing the entire history.

For example:

```text
10:00  Meta Ad A -> product view
14:00  Meta Ad B -> add to cart -> checkout
```

materializes as:

```text
Touch 1: META / Ad A
Touch 2: META / Ad B
```

Repeated events with the same attribution context do not create duplicate touches.

### Source classification

Observed sources are classified in this order:

1. Meta provider ID or `fbclid`
2. Google `gclid`
3. TikTok `ttclid`
4. UTM evidence
5. referrer-only evidence
6. direct page/landing evidence
7. unknown

This classification is observational, not an attribution model.

## Exact Meta resolution

When exact Meta IDs are present, the read model resolves them against the store-scoped synchronized Meta hierarchy.

Resolution states:

- `EXACT` — exact ad resolved and supplied parent IDs agree with the synchronized hierarchy.
- `PARTIAL` — only an ad set or campaign can be resolved.
- `UNRESOLVED` — provider IDs were observed but are not present in the current synchronized snapshot.
- `CONFLICT` — supplied campaign/ad-set IDs disagree with the resolved ad hierarchy.
- `NONE` — no exact Meta hierarchy identity was supplied.

A conflict is surfaced as a data-quality limitation rather than silently corrected.

## Shopify product resolution

Product, variant and collection IDs emitted by Shopify Web Pixel events are resolved to synchronized Stride Shopify rows.

A variant match is strongest because its synchronized product parent is known. If an event supplies a product ID that conflicts with the variant's synchronized parent, the session is marked with `SHOPIFY_PRODUCT_ID_CONFLICT`.

## Exact Shopify order linkage

On Shopify's `checkout_completed` event, Stride captures:

- `checkout.token`
- `checkout.order.id`

Only those identifiers are used for linkage. The Pixel does not import protected checkout contact/payment fields or duplicate Shopify monetary truth.

The materializer then looks up the order by the exact composite identity:

```text
(storeId, shopifyOrderId)
```

Link status is:

- `LINKED` — the exact Shopify order already exists in Stride.
- `PENDING` — checkout completion supplied an order ID, but Shopify order ingestion has not arrived yet.
- `NONE` — no Shopify order ID was observed.

There is deliberately no fuzzy matching by timestamp, value, customer, product list or order name.

A background reconciliation pass retries `PENDING` links after normal Shopify ingestion catches up.

## Eventual correctness

Raw `StorefrontEvent` writes remain the durable collector contract. Session rows are derived read models.

After ingestion:

1. Stride durably stores eligible raw events.
2. It attempts immediate session materialization.
3. A materialization failure does not reject an otherwise valid collector write.
4. A repair worker finds sessions whose newest raw `receivedAt` watermark is newer than the materialized session watermark.
5. The complete session is rebuilt deterministically from raw events.
6. Pending Shopify order links are reconciled separately.

This keeps browser retries/idempotency independent from read-model availability.

## Retention

`StorefrontSession` and its touch/product/collection children expire with the raw event retention horizon. Deleting a session cascades to its child read rows.

PIXEL-3 should persist long-term behavioral analytics as store/product/ad/date aggregates rather than retaining indefinite pseudonymous visitor histories.

## Read API

Authenticated store members can read:

```text
GET /v1/stores/:storeId/pixel/sessions
GET /v1/stores/:storeId/pixel/sessions/:sessionId
GET /v1/stores/:storeId/pixel/journeys/:anonymousVisitorId
```

Session list filters support time range, observed source, exact Meta ad ID, Shopify product external ID, and checkout-completed state.

Session detail includes the materialized read model and the sanitized raw event timeline still available inside the retention window.

The visitor journey endpoint returns sessions chronologically and explicitly describes them as observed first-party evidence, not causal attribution.

## Deferred to PIXEL-3+

PIXEL-2B does not calculate:

- product conversion rate
- session conversion rate
- funnel drop-off
- landing-page quality metrics
- first-touch or last-touch credited revenue
- assisted-conversion reporting
- incrementality or causal lift
- predictive recommendations

Those require aggregate behavioral facts and explicit metric semantics built on this read model.
