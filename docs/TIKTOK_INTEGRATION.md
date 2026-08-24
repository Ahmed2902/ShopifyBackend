# TikTok Marketing API integration

TikTok is a provider-specific ingestion module. Raw TikTok persistence stays separate from Meta; the intelligence layer normalizes both providers later.

## App configuration

The integration targets TikTok API for Business Marketing API v1.3.

Required backend environment variables:

```env
TIKTOK_APP_ID=...
TIKTOK_APP_SECRET=...
TIKTOK_SCOPES=
TIKTOK_REDIRECT_URI=https://api.example.com/v1/integrations/tiktok/callback
TIKTOK_API_VERSION=v1.3
TIKTOK_STATE_SECRET=<32+ random characters>
TIKTOK_WEBHOOK_URL=https://api.example.com/v1/integrations/tiktok/webhooks
TIKTOK_WEBHOOK_MAX_AGE_SECONDS=300
```

`TIKTOK_SCOPES` may be empty when permissions are managed in the TikTok developer app configuration.

The merchant-facing app needs read permissions for advertisers/campaigns/ad groups/ads/reporting and, when catalogs are used, Business Center/catalog read permissions.

## Frontend connection flow

1. `POST /v1/stores/:storeId/integrations/tiktok/install` as OWNER/ADMIN.
2. Navigate the browser to the returned `authorizationUrl`.
3. TikTok redirects to `GET /v1/integrations/tiktok/callback`.
4. The backend validates signed 10-minute OAuth state, exchanges `auth_code`, validates advertiser access, encrypts the token, and redirects to `/app/integrations?tiktok=connected&storeId=...`.
5. `GET /assets` returns accessible advertisers, Business Centers and catalogs.
6. `POST /configure` chooses advertiser accounts and optionally a Business Center.
7. `POST /catalogs/configure` chooses catalogs.
8. Run `/sync`, `/catalogs/sync` and `/insights/sync` for the initial backfill.

## Data synced

### Advertising hierarchy

- Advertisers
- Manual campaigns
- Manual ad groups
- Manual ads
- Upgraded Smart+ campaigns
- Upgraded Smart+ ad groups
- Upgraded Smart+ ads
- creative metadata available on ad payloads (identity, Spark post, video/image IDs, text, CTA, landing URL, catalog/product set)

The API client merges regular and `/smart_plus/.../get` results before persistence. Upgraded Smart+ nested creative structures are normalized without discarding the raw provider payload. Smart+ endpoint failures are treated as sync failures rather than empty snapshots so a transient provider problem cannot tombstone previously valid Smart+ data.

### Catalogs

- Business Center catalogs
- catalog products/items
- retailer/SKU and item-group identifiers
- price/sale price/currency
- Shopify mapping evidence

### Daily reporting

Default incremental lookback is 35 days, chunked into 28-day requests.

Stored ad-level metrics include:

- spend
- impressions/reach/clicks
- CTR/CPC/CPM/frequency
- website purchases/value/CPA/ROAS
- video play actions
- 2-second and 6-second views
- 25/50/75/100% video completion views
- full raw dimensions/metrics payloads

For Upgraded Smart+, the integration queries the reporting `ad_id_v2` dimension so reporting maps to the actual Smart+ ad/asset-group ID. It aliases that value internally to the common TikTok ad identifier consumed by persistence.

TikTok's reporting field `total_complete_payment_rate` has a misleading API name. In the current reporting schema it represents **total complete-payment value**, not a percentage rate; it is therefore stored as `conversionValue`. The raw metrics payload is retained alongside the normalized value so this semantic remains auditable.

## Mapping to Shopify

Automatic evidence can come from catalog retailer/SKU identifiers, product/item group identifiers, product URLs, landing pages and creative product metadata. Merchant-confirmed mappings are preserved when automatic reconciliation runs again.

Manual endpoints remain available for an ad or catalog item when deterministic evidence is insufficient.

## Webhooks

Public callback:

```text
POST /v1/integrations/tiktok/webhooks
```

Webhook credentials are **not** placed in callback query parameters or URLs. The receiver requires `TikTok-Signature` and validates its timestamp plus HMAC against the exact raw request body before accepting a delivery. This avoids leaking a long-lived credential through application/proxy access logs.

Deliveries are deduplicated and persisted before asynchronous reconciliation. The worker has bounded retries and stale-claim recovery.

Recognized events reconcile rather than trusting webhook payloads as canonical state:

- `REPORT_DATA_CHANGE` -> recent Insights sync
- catalog/product events -> catalog sync
- ad/ad-group review, creative fatigue and related ad-account changes -> hierarchy sync

Payloads containing multiple advertiser IDs are matched against **all** currently selected connections. When the same advertiser/event affects more than one configured store, each matching store receives its own durable delivery and reconciliation work.

TikTok's Reporting Subscription API methods are implemented in the provider client. Subscription provisioning can be enabled once the production TikTok app has the corresponding reporting subscription permission and the production app confirms the signature contract for that Business API webhook surface.

## Security

- install is OWNER/ADMIN only
- signed expiring OAuth state binds user and store
- denied OAuth callbacks also validate state
- access tokens are encrypted at rest
- API calls use bounded retries and timeouts
- selected advertisers/catalogs are revalidated against provider access before persistence
- reads are restricted to the connection's currently selected advertisers/catalogs
- webhooks are verified against the exact raw body before durable processing
- provider responses are scoped to the selected store/account before mapping
- BigInt provider counters are converted to JSON-safe strings at the HTTP boundary

## Deliberate exclusions

This integration does not send conversion events to TikTok Events API and does not mutate campaign budgets/statuses. Those are separate execution/measurement capabilities and are not required for the pre-AI intelligence read path.

TikTok Creative Fatigue Detection is allowlist-only. We store the reporting/video signals required to calculate our own deterministic fatigue indicators instead of making the core product depend on that allowlist.
