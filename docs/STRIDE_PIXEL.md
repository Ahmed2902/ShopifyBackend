# Stride Pixel — first-party storefront event contract

## Status

This document defines **PIXEL-0** only: the event contract, privacy model, anonymous identity rules, idempotency and retention metadata for Stride's first-party storefront behavioral dataset.

PIXEL-0 does **not** add a public collector endpoint, Shopify Web Pixel/custom-pixel installation flow, session read model, order linkage, behavioral analytics or attribution claims. Those belong to PIXEL-1 through PIXEL-4.

## Why this layer exists

Stride currently has three kinds of evidence:

```text
Shopify -> neutral commerce truth
Meta    -> provider-attributed advertising evidence
Stride  -> mapping/exposure evidence joining the two where defensible
```

Those layers do not provide Stride with a neutral first-party view of what a visitor did on the storefront before purchase.

Stride Pixel adds a fourth layer:

```text
Stride Pixel -> first-party storefront behavioral/journey evidence
```

It remains separate from Shopify revenue truth and provider attribution claims. A storefront event must never overwrite Shopify order/revenue facts or be presented as causal incrementality.

## Initial event names

```text
PAGE_VIEW
PRODUCT_VIEW
COLLECTION_VIEW
SEARCH
ADD_TO_CART
REMOVE_FROM_CART
BEGIN_CHECKOUT
CHECKOUT_PROGRESS
CHECKOUT_COMPLETED
```

`CHECKOUT_COMPLETED` is a behavioral event only. Shopify orders remain the purchase/revenue source of truth. A later read model may link a session/journey to a reconciled Shopify order.

## Event envelope

Collector-facing events are versioned. PIXEL-0 defines version `1`.

```ts
{
  eventId: string;
  eventVersion: 1;
  eventName: StorefrontEventName;
  eventAt: string; // UTC ISO timestamp

  anonymousVisitorId?: string;
  sessionId?: string;
  consentState: 'UNKNOWN' | 'GRANTED' | 'DENIED' | 'NOT_REQUIRED';

  pageUrl?: string;
  referrerUrl?: string;
  landingPageUrl?: string;

  productExternalId?: string;
  variantExternalId?: string;
  collectionExternalId?: string;
  quantity?: number;

  attribution?: {
    utmSource?: string;
    utmMedium?: string;
    utmCampaign?: string;
    utmContent?: string;
    utmTerm?: string;
    metaClickId?: string;
    googleClickId?: string;
    tiktokClickId?: string;
  };
}
```

External merchandise IDs are intentionally provider/storefront identities rather than Stride database UUIDs. PIXEL-2 may resolve them to normalized Shopify entities.

## Event-specific minimums

- `PRODUCT_VIEW` requires a product or variant external identity.
- `COLLECTION_VIEW` requires a collection external identity.
- `ADD_TO_CART` / `REMOVE_FROM_CART` require a product or variant external identity.
- `quantity` is accepted only for cart mutation events.
- `SEARCH` records the behavioral fact in PIXEL-0 but intentionally does **not** accept raw search text yet, because arbitrary search strings may contain accidental personal data.

## Privacy model

### No raw customer PII in the event contract

PIXEL-0 intentionally has no fields for:

```text
email
phone
name
postal address
IP address
raw cookies
raw request body
raw user-agent fingerprint
customer-account identifier
```

The collector schema is strict, so unexpected fields are rejected rather than silently persisted.

Future order/customer linkage must happen through an explicit privacy-reviewed server-side process instead of adding direct customer PII to browser events.

### Anonymous visitor and session identities

`anonymousVisitorId` and `sessionId` are opaque random identifiers.

Rules:

- scoped to one Store's first-party context;
- not derived from email, phone, IP, user-agent or device fingerprinting;
- not intended for cross-merchant identity stitching;
- not sufficient on their own to identify a Shopify customer;
- may be omitted when the supported storefront/privacy surface does not permit persistence.

PIXEL-1 owns generation/storage mechanics.

### Consent/privacy state

Every event carries an explicit privacy state:

```text
UNKNOWN      -> Stride does not treat this as permission to capture behavior
GRANTED      -> behavior capture is allowed
DENIED       -> behavior capture is not allowed
NOT_REQUIRED -> caller/platform indicates capture is permitted without an opt-in state
```

PIXEL-0 deliberately does not infer jurisdiction or legal basis. The supported Shopify storefront surface and merchant configuration must provide the privacy state later.

`isStorefrontBehaviorCaptureAllowed()` is conservative: only `GRANTED` and `NOT_REQUIRED` return true.

## URL and attribution handling

Raw page URLs can contain personal or sensitive query parameters. Stride therefore separates page identity from attribution parameters.

Before persistence:

1. parse the browser URL;
2. allowlist attribution parameters;
3. store those parameters in dedicated fields;
4. remove credentials, the entire query string and fragment from the persisted page/referrer/landing URL.

PIXEL-0 allowlists:

```text
utm_source
utm_medium
utm_campaign
utm_content
utm_term
fbclid  -> metaClickId
gclid   -> googleClickId
ttclid  -> tiktokClickId
```

Unknown query parameters are not copied into event metadata.

Only `http:` and `https:` URLs are accepted by the privacy sanitizer.

## Idempotency

Browser delivery can be retried or batched, and future browser/server paths may overlap. Every event therefore has a caller-generated `eventId`.

Persistence enforces:

```text
UNIQUE(storeId, eventId)
```

This makes event identity Store-scoped and provides the durable deduplication boundary for PIXEL-1 ingestion.

Events are append-only facts. PIXEL-1 should treat a duplicate event ID as an idempotent duplicate, not mutate the already-recorded event into a new meaning.

## Time semantics

- `eventAt` is the event's UTC occurrence time supplied by the collector.
- `receivedAt` is the backend receipt time.
- reporting later converts to the Store's IANA timezone.
- server logic must tolerate bounded network delay without rewriting `eventAt` to `receivedAt`.

## Retention policy

PIXEL-0 defines a product default of **90 days** for raw storefront events and a maximum supported raw-event retention window of **365 days**.

This is a Stride product/data-minimization policy, **not a statement that one retention period satisfies every merchant's legal obligations**.

Every persisted event has a mandatory `retentionExpiresAt`, with an index dedicated to expiry cleanup.

PIXEL-1/operational worker work must enforce deletion of expired raw events. Aggregated/read-model retention may later be different, but it must not retain direct event-level identifiers indefinitely by accident.

## Persistence

`StorefrontEvent` stores the privacy-minimized normalized envelope:

- Store ownership;
- event identity/version/type/time;
- anonymous visitor/session IDs when permitted;
- consent state;
- sanitized page/referrer/landing URLs;
- Shopify external product/variant/collection identities;
- cart quantity where relevant;
- allowlisted UTM/provider click IDs;
- retention expiry.

Useful query indexes exist for:

```text
store + event time
store + event type + event time
store + anonymous visitor + event time
store + session + event time
retention expiry
```

No session or attribution aggregate is materialized in PIXEL-0.

## Truth boundaries

Adding Stride Pixel does not change the existing money/attribution rules:

```text
Shopify commerce revenue != Meta attributed revenue
Shopify commerce revenue != Stride first-party attributed revenue
Meta attributed revenue    != Stride first-party attributed revenue
```

Future first-touch/last-touch/path outputs are descriptive journey attribution evidence. They must remain labeled separately from provider attribution and from causal/incrementality claims.

## Next phases

### PIXEL-1 — storefront collector + ingestion

- Shopify-compatible supported collector surface;
- first-party ingestion endpoint;
- batch/retry handling;
- durable duplicate handling through `(storeId,eventId)`;
- consent gate before persistence;
- URL sanitization + attribution extraction before write;
- retention-expiry assignment;
- debug/validation mode;
- expired-event cleanup worker.

### PIXEL-2 — session/journey read model

- session boundaries;
- landing pages;
- visitor/session paths;
- UTM/click-ID propagation;
- normalized Shopify product/collection resolution;
- privacy-reviewed Shopify order linkage.

### PIXEL-3 — behavioral analytics

- product/collection views;
- add-to-cart funnel metrics;
- landing-page performance;
- time-to-conversion;
- behavioral support for product/collection diagnosis.

### PIXEL-4 — attribution/mapping enrichment

- first/last/path attribution evidence;
- stronger ad -> product/collection mapping evidence;
- cross-channel assist evidence;
- explicit methodology/coverage/limitations.
