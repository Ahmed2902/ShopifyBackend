# PIXEL-4 — First-party attribution and mapping enrichment

PIXEL-4 turns the privacy-bounded PIXEL-2 journey model into durable descriptive attribution evidence and mapping suggestions.

## Truth boundary

This layer does not create a universal attribution truth.

Stride keeps four different evidence families separate:

1. Shopify commerce truth
2. Meta provider attribution claims
3. Stride mapping/exposure evidence
4. Stride first-party journey evidence

First/last/assisted touch metrics are descriptive observations from the retained first-party path. They are not causal incrementality claims.

## Purchase truth

A purchase journey exists only when the current Pixel session is exactly linked to a non-test, non-cancelled Shopify order.

No fuzzy timestamp, price, customer, SKU-nearby, or revenue matching is used.

## Journey window

PIXEL-4 uses a bounded 30-day first-party lookback for a linked purchase. If the anonymous first-party visitor ID has earlier retained sessions in that window, their ordered touches are included in the observed path.

Definitions:

- first touch: first observed touch in the retained 30-day path
- last touch: final observed touch in the retained 30-day path
- assisted touch: an observed touch before the final observed touch
- cross-session purchase: a linked purchase path containing more than one first-party session

## Durable aggregates

`StorefrontAttributionDaily` stores source/ad-level aggregate counts without visitor IDs or click IDs.

`StorefrontAttributionPathDaily` stores source-only paths such as:

```text
SESSION:META>DIRECT
JOURNEY:META>DIRECT>META
```

It never stores campaign/ad IDs inside the path string.

`StorefrontMetaTargetEvidenceDaily` stores exact resolved Meta-ad + Shopify product/collection interaction evidence. It contains no visitor identity.

Raw browser events and pseudonymous session histories continue to expire under the Pixel retention policy.

## Mapping enrichment

Pixel behavioral association is intentionally weaker than exact Product x Ads mapping evidence.

A Pixel-only mapping suggestion requires at least:

- 5 interacting sessions
- 60% of those sessions viewing the target

Pixel-only suggested confidence is capped at `0.69`, below Stride's existing `0.70` automatic exact Product x Ads mapping threshold.

Therefore Pixel-only evidence never automatically activates an exact mapping.

Merchant-confirmed mappings always win. Conflicting behavioral evidence is surfaced for review instead of overwriting merchant truth.

Multiple sufficiently supported products for one ad are surfaced as possible shared/multi-product scope rather than splitting spend across products.

## APIs

Authenticated store members can read:

- `GET /v1/stores/:storeId/pixel/attribution/sources`
- `GET /v1/stores/:storeId/pixel/attribution/meta-ads`
- `GET /v1/stores/:storeId/pixel/attribution/paths`
- `GET /v1/stores/:storeId/pixel/attribution/mapping-evidence?targetType=PRODUCT`
- `GET /v1/stores/:storeId/pixel/attribution/mapping-evidence?targetType=COLLECTION`

Date ranges use Stride's normal store-timezone boundaries and equal preceding comparison period.

## Eventual correctness

The attribution worker watches `StorefrontSession.updatedAt`, so it reacts to:

- newly materialized sessions
- repaired session paths
- late `PENDING -> LINKED` Shopify order linkage

If an earlier session for a visitor changes, later linked-purchase dates within the 30-day lookback are rebuilt so first/last/assist evidence stays consistent.

The attribution rollup runs before Pixel trace-retention cleanup.
