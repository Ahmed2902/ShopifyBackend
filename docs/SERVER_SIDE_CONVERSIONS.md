# Stride server-side purchase conversions

## Scope

Stride can deliver Shopify-backed `Purchase` conversions server-side to:

- Meta Conversions API
- TikTok Events API
- Google Data Manager API for Google Ads

This subsystem is intentionally provider-neutral above the final HTTP adapters. It does **not** treat a browser `CHECKOUT_COMPLETED` event as revenue truth. A conversion is eligible only after Stride has a persisted Shopify `Order` linked to a Stride storefront session.

## Truth and privacy boundaries

1. Shopify `Order` owns purchase time, value, currency, cancellation/test status and order identity.
2. Stride Pixel contributes only consented provider click identifiers from the linked session (`fbclid`, `gclid`, `ttclid`).
3. The initial release does not require or persist customer email, phone, name, address, IP address or user-agent data.
4. `UNKNOWN` or `DENIED` storefront consent never supplies a click identifier to conversion delivery.
5. Successful deliveries immediately scrub the click identifier, attribution timestamp and source URL from the durable delivery record.
6. Shopify `customers/redact` deletes matching pending/retry/delivery records before the order is erased. `shop/redact` removes the whole store and therefore cascades destinations/deliveries.

## Durable delivery model

`ConversionDestination` represents a provider destination:

- Meta: Dataset/Pixel ID plus encrypted Events Manager access token.
- TikTok: Pixel code plus encrypted Events Manager access token.
- Google Ads: conversion action ID. OAuth credentials remain in the existing `GoogleAdsConnection`; destination config carries the operating/login customer IDs.

`ConversionDelivery` is an idempotent provider-specific delivery of one Shopify purchase.

The uniqueness boundary is:

```text
(destinationId, eventKey)
```

Purchase event keys are deterministic:

```text
stride:purchase:<shopifyOrderId>
```

The worker claims rows with `FOR UPDATE SKIP LOCKED`, recovers stale processing claims, retries transient provider/network failures with bounded exponential backoff, and dead-letters permanent failures or rows that exhaust the retry budget.

Background delivery also enforces Stride billing:

- active/trialing subscription required;
- Pro can deliver to configured providers;
- Essentials only delivers to its selected `essentialsAdProvider`.

## API

All routes are tenant-scoped under:

```text
/v1/stores/:storeId/conversion-delivery
```

Authenticated store membership and an active subscription are required. Destination writes require Owner/Admin.

### Configure Meta

```http
PUT /v1/stores/:storeId/conversion-delivery/destinations
Content-Type: application/json

{
  "provider": "META",
  "externalId": "<dataset-or-pixel-id>",
  "displayName": "Meta purchases",
  "accessToken": "<events-manager-token>",
  "testEventCode": "<optional-test-events-code>"
}
```

### Configure TikTok

Stride sends TikTok's current `Purchase` standard event name for new Web/Events API integrations.

```http
PUT /v1/stores/:storeId/conversion-delivery/destinations
Content-Type: application/json

{
  "provider": "TIKTOK",
  "externalId": "<pixel-code>",
  "displayName": "TikTok purchases",
  "accessToken": "<events-api-token>",
  "testEventCode": "<optional-test-event-code>"
}
```

### Configure Google Ads

Google uses the existing Google Ads OAuth connection. Reconnect once after this release so the grant includes both `adwords` and `datamanager` scopes.

```http
PUT /v1/stores/:storeId/conversion-delivery/destinations
Content-Type: application/json

{
  "provider": "GOOGLE_ADS",
  "externalId": "<conversion-action-id>",
  "displayName": "Google purchase",
  "customerId": "1234567890",
  "loginCustomerId": "1234567890",
  "googleConsentMode": "ACCOUNT_DEFAULT"
}
```

`googleConsentMode=GRANTED` is available only when the merchant's consent implementation is known to authorize both Google ad user data and ad personalization for these events. `ACCOUNT_DEFAULT` omits explicit granted consent and relies on the Google destination/account configuration.

### Diagnostics

```text
GET  /v1/stores/:storeId/conversion-delivery/destinations
GET  /v1/stores/:storeId/conversion-delivery/deliveries?provider=META&status=DEAD&limit=50
POST /v1/stores/:storeId/conversion-delivery/destinations/:destinationId/disable
```

Destination read responses never expose encrypted access tokens.

## Provider matching

The initial matching inputs are deliberately narrow:

```text
Meta      <- consented fbclid/fbc
TikTok    <- consented ttclid
Google    <- consented gclid
```

Email/phone-based enhanced matching can be added later as optional enrichment after Shopify protected-customer-data approval. It is not a prerequisite for this server-side Purchase pipeline.

## Deduplication boundary

Stride guarantees **server-side idempotency** for retries/replays of its own delivery through the deterministic event key and database uniqueness.

Provider-side browser/server deduplication is a separate concern. If a merchant also sends the same Purchase through another browser/server integration, that integration must use the provider's corresponding deduplication mechanism (for example the same event ID where the provider requires one). Stride must not claim that an unrelated third-party/native pixel has the same event ID unless Stride can verify it.

## Operations

Workers:

- every 30 seconds: discover recent linked Shopify purchases and enqueue missing provider deliveries;
- every 2 seconds: claim and send a bounded delivery batch.

Only non-test, non-cancelled Shopify orders with a non-null total are eligible. Initial discovery is limited to purchases from the last 30 days to avoid unexpectedly backfilling old conversions when a destination is enabled.

## Enhanced signals extension

See [Enhanced conversion signals](ENHANCED_CONVERSION_SIGNALS.md) for current acquisition dimensions, deterministic identity, opt-in matching/funnel delivery, consent and retention contracts. Older Purchase-only descriptions above describe the prior foundation. The extension preserves commerce/provider/first-party evidence separation.
