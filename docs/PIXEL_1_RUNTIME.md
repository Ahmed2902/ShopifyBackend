# PIXEL-1 — storefront collector and ingestion runtime

## Status

PIXEL-1 implements the runtime path on top of the PIXEL-0 event/privacy contract.

```text
Shopify App Web Pixel
  -> public Stride collector
    -> credential + consent gate
      -> contract validation
        -> privacy normalization
          -> durable StorefrontEvent persistence
```

This phase still does **not** build the session/journey read model, order linkage, behavioral analytics, first/last/path attribution, or causal claims. Those remain PIXEL-2 through PIXEL-4.

## Store API

Authenticated Store members:

```text
GET /v1/stores/:storeId/pixel/status
```

Owner/Admin only:

```text
POST /v1/stores/:storeId/pixel/install
POST /v1/stores/:storeId/pixel/debug/validate
```

`install` creates or updates the Shopify `WebPixel` resource using the store's existing Shopify connection. It requires the Shopify-granted scopes:

```text
write_pixels
read_customer_events
```

Existing stores that were authorized before those scopes were added must reconnect/reauthorize before installation can succeed.

## Public collector

```text
POST /v1/pixel/events
```

The endpoint is intentionally unauthenticated by user JWT because it receives browser-sandbox traffic. Authentication is instead per pixel installation:

```text
installationId
collectorToken
```

The raw collector token:

- is generated with 32 bytes of CSPRNG entropy;
- is passed into Shopify Web Pixel settings;
- is stored by Stride only as a SHA-256 hash;
- is compared using a timing-safe comparison;
- is rotated when the merchant re-runs pixel installation;
- is never returned by the status/install response after persistence.

The endpoint has:

- a dedicated public CORS policy;
- a dedicated source rate limit;
- a 128 KiB request-body limit;
- a maximum of 50 events per accepted server batch;
- support for `text/plain` JSON so the strict Shopify Web Pixel sandbox can send without custom request headers/preflight;
- strict Zod envelope/event validation.

## Persistence behavior

Before a write, the service:

1. resolves the installation to the server-owned Store;
2. verifies the installation is `ACTIVE`;
3. verifies the collector token;
4. suppresses events whose consent state does not permit behavioral capture;
5. strips page/referrer/landing query strings and fragments;
6. extracts only allowlisted UTM/provider click identifiers;
7. attaches a retention expiry timestamp;
8. inserts with Store-scoped durable event-ID deduplication.

The browser is never allowed to supply `storeId` directly.

Duplicate delivery is reported in the response and does not mutate the previously persisted event.

## Consent

The Shopify collector source consumes Shopify's Web Pixels customer-privacy state. It subscribes only to standard events and drops analytics behavior when `analyticsProcessingAllowed` is false.

The backend independently applies the PIXEL-0 consent gate. `UNKNOWN` and `DENIED` therefore remain non-persistable even if a buggy or non-Shopify caller attempts to send them.

This is intentional defense in depth.

## Shopify extension source

The collector source lives at:

```text
extensions/stride-pixel/src/index.js
```

`extensions/stride-pixel/shopify.extension.toml.template` contains the expected privacy/settings schema.

A deployable Shopify extension config is **not** checked in with a made-up UID. Shopify CLI must generate the extension and its real UID in the actual Shopify app project; see `extensions/stride-pixel/README.md`.

## Retention

Raw `StorefrontEvent` rows carry `retentionExpiresAt` from PIXEL-0. PIXEL-1 adds an operational cleanup worker that deletes expired events in bounded batches.

Default raw-event retention remains 90 days and is configurable up to the PIXEL-0 maximum of 365 days through:

```text
PIXEL_RAW_EVENT_RETENTION_DAYS
```

## Operational status

`PixelInstallation` tracks:

```text
status
shopifyWebPixelId
collectorTokenPrefix
installedAt
lastEventAt
lastError
```

The raw token is intentionally absent.

`lastEventAt` lets future data-quality surfaces distinguish an installed pixel from one that is no longer producing storefront evidence.

## Truth boundary

`CHECKOUT_COMPLETED` remains storefront behavioral evidence only.

It does not create an Order and it does not become commerce revenue truth. PIXEL-2 must link journeys to reconciled Shopify orders explicitly.
