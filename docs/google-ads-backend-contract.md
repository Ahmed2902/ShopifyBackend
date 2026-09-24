# Google Ads backend contract

This document freezes the backend contract for the frontend Google Ads worker on top of Stride's canonical paid-media model.

## Provider identity

- Provider enum: `GOOGLE_ADS`
- Canonical account: `AdvertisingAccount.provider = GOOGLE_ADS`
- `AdvertisingAccount.providerEntityId` is the normalized 10-digit Google Ads customer ID.
- Client-facing shared paid-media reads use canonical `AdvertisingAccount.id` UUIDs. Google customer IDs are never accepted as a substitute for a canonical account UUID in shared reads.

## Configuration

Required production configuration when Google Ads is enabled:

- `GOOGLE_ADS_CLIENT_ID`
- `GOOGLE_ADS_CLIENT_SECRET`
- `GOOGLE_ADS_DEVELOPER_TOKEN`
- `GOOGLE_ADS_STATE_SECRET` (at least 32 characters)
- `GOOGLE_ADS_REDIRECT_URI` (recommended explicit production callback)
- `GOOGLE_ADS_API_VERSION` (defaults to `v25` in this branch)

Google Ads API requests require both OAuth 2.0 authorization and a Google Ads developer token. Stride sends the developer token on every Google Ads API request and fails with `GOOGLE_ADS_NOT_CONFIGURED` before issuing a request when the token is absent.

Google Ads OAuth is intentionally separate from ordinary Stride Google login.

## Integration endpoints

All store endpoints are under `/v1/stores/:storeId/integrations/google-ads`.

### POST `/install`

Requires authentication, store membership, OWNER/ADMIN, and an active subscription.

Response:

```json
{ "authorizationUrl": "https://accounts.google.com/o/oauth2/v2/auth?..." }
```

The URL requests the Google Ads `adwords` scope and offline access. OAuth state is HMAC-signed, store/user-bound, and short lived. The callback verifies that the `adwords` scope was actually granted before persisting the connection.

### GET `/v1/integrations/google-ads/callback`

Google OAuth callback. Exchanges the authorization code, stores encrypted provider credentials, discovers directly accessible customer IDs, then redirects to the frontend integrations page. Provider tokens are never returned to the frontend.

### GET `/status`

Response is `null` when Google Ads has never been connected, otherwise:

```json
{
  "id": "uuid",
  "status": "ACTIVE | REAUTH_REQUIRED | DISCONNECTED",
  "selectedCustomerIds": ["1234567890"],
  "scopes": ["https://www.googleapis.com/auth/adwords"],
  "apiVersion": "v25",
  "lastSyncedAt": "ISO timestamp or null",
  "lastSyncStatus": "SUCCEEDED | PARTIAL | FAILED | null",
  "lastSyncError": "sanitized error code/string or null"
}
```

`lastSyncedAt` is the last fully successful sync timestamp. A partial or failed run updates sync status/error evidence without replacing the last successful timestamp.

### GET `/customers`

OWNER/ADMIN only. Discovers directly accessible customers and traverses manager-account hierarchies. The frontend should display client accounts for selection and may display manager accounts as hierarchy context, but managers cannot be selected for analytics ingestion.

Each customer includes:

```json
{
  "customerId": "1234567890",
  "loginCustomerId": "0987654321 or null",
  "descriptiveName": "Store Ads",
  "status": "ENABLED",
  "currencyCode": "USD",
  "timeZone": "America/New_York",
  "manager": false,
  "testAccount": false,
  "level": 1,
  "parentCustomerId": "0987654321 or null"
}
```

Manager-mediated calls use the appropriate `login-customer-id`; direct client access does not invent one.

### POST `/configure`

Body:

```json
{ "customerIds": ["1234567890"] }
```

The backend revalidates accessibility before persisting selection. At least one client account is required; manager accounts and inaccessible customers fail closed. Shared account-scoped reads additionally resolve a canonical account UUID only inside the current store, `GOOGLE_ADS` provider, and currently selected customer IDs.

### POST `/sync`

Body:

```json
{ "mode": "HISTORICAL | INCREMENTAL" }
```

`HISTORICAL` uses a bounded 365-day bootstrap split into 30-day reporting windows. Completed metric-level windows are checkpointed per customer so a partial historical retry skips already-committed windows. Checkpoints are cleared only after the entire selected-account historical run succeeds. `INCREMENTAL` refreshes a rolling 35-day window so attribution-lagged Google metrics can change safely. Google Search pagination is bounded, retry/backoff is bounded, writes use deterministic identities/metric keys, and removed hierarchy entities are tombstoned rather than physically deleted.

The response also includes deterministic Google final-URL mapping counts:

```json
{
  "recordsRead": 100,
  "recordsWritten": 90,
  "partial": false,
  "failures": [],
  "mappings": {
    "productMappings": 4,
    "collectionMappings": 1,
    "unmappedAds": 3
  }
}
```

### POST `/disconnect`

Attempts to revoke the Google OAuth refresh token, then always clears locally persisted credentials/selection and changes the connection state to `DISCONNECTED`. A failed/already-invalid remote revocation does not leave reusable credentials inside Stride.

## Canonical hierarchy

Normal Google Ads structures:

```text
AdvertisingAccount
  -> AdvertisingCampaign
      -> AdvertisingGroup(kind = AD_GROUP)
          -> AdvertisingAd
```

Performance Max is represented truthfully:

```text
AdvertisingAccount
  -> AdvertisingCampaign
      -> AdvertisingGroup(kind = ASSET_GROUP)
```

Stride does not fabricate an `AdvertisingAd` for PMax where Google does not expose a normal ad entity.

Google assets are normalized into `AdvertisingCreative` where a stable asset identity exists. PMax asset-to-asset-group relationships, field type, provider status, and performance label are retained inside provider data because the relationship is many-to-many rather than a fake one-ad/one-creative mapping.

## Shared paid-media reads

The provider registry exposes Google with:

- levels: `CAMPAIGN`, `GROUP`, `AD`, `CREATIVE`
- group kinds: `AD_GROUP`, `ASSET_GROUP`
- group label: `Ad Group / Asset Group`
- attribution model: `PROVIDER_REPORTED`
- reach: period reach is unavailable unless Google exposes trustworthy deduplicated period evidence
- assets: entities are readable, but Stride does not claim asset-level normalized delivery metrics

The shared read-only MCP `stride_get_paid_media` provider enum includes `GOOGLE_ADS`; it delegates to the same provider-neutral advisor/provider registry used by HTTP analytics. MCP remains store-bound, entitlement checked, read-only, and token-free. Google PMax/asset/attribution limitations are exposed through provider capabilities.

## Billing / channel entitlement

`GOOGLE_ADS` participates in the same V1 ad-channel contract as Meta/TikTok:

- Essentials allows one selected connected advertising provider.
- Pro permits multiple advertising providers.
- Google connection state is included in shared connected-provider discovery.
- Read-only MCP checks do not auto-select or mutate the Essentials provider.

## Metrics

Daily canonical metrics include, where Google returns them:

- spend (`cost_micros` converted exactly)
- impressions
- clicks
- CTR
- average CPC
- average CPM
- conversions
- conversion value
- cost per conversion (micros converted exactly)
- conversion value / cost (provider ROAS)

`metrics.conversions` and `metrics.conversions_value` are explicitly Google-provider attribution evidence. They are not Shopify orders or Shopify revenue. `all_conversions` and `all_conversions_value` remain provider-specific supplemental metrics.

Daily reach is not summed. Canonical Google reach/frequency stay unavailable unless trustworthy non-additive evidence is added later.

## Product × Ads

For normal Google ads, Stride projects a mapping only when a Google final URL belongs to the current Shopify store and deterministically resolves to exactly one Shopify product, variant, or collection. These mappings use canonical `AdvertisingProductMapping` / `AdvertisingCollectionMapping`, carry explicit evidence/confidence, and stale non-merchant mappings are expired on re-sync.

PMax Asset Groups do not get fake `AdvertisingAd` rows. Therefore PMax/Shopping spend is not divided among products just because an Asset Group or listing structure exists. Until product-level listing-group/Merchant Center evidence is represented at a truthful structural level, that spend remains shared/unmapped.

## Error model

Provider errors are sanitized before they reach clients. Important distinctions include:

- disconnected / not selected
- OAuth refresh required (`401`)
- required OAuth scope missing
- Google Ads developer token/configuration missing
- inaccessible customer
- Cloud project/API production access not approved
- other Google API authorization failures (`403`)
- rate limiting (`429`) with bounded retry/backoff
- bounded pagination failure
- partial multi-customer sync

A Google API authorization failure is not automatically mislabeled as an expired OAuth token.

## Data-quality semantics

The frontend should surface:

- connection status
- selected accounts
- last successful sync timestamp
- latest sync status
- sanitized partial/failure state
- provider capability limitations

Never render unavailable evidence as zero. Never sum Meta/TikTok/Google attributed conversion value and label it Shopify revenue. Same-currency provider spend can be compared/combined only under the shared currency policy.

## Remaining limitations

- Deterministic normal-ad final URLs participate in Product × Ads, but PMax/Shopping product allocation remains deliberately unclaimed until listing-group/Merchant Center evidence can be represented without a fake ad or guessed spend split.
- Google test accounts are suitable for OAuth/resource/query contract testing but do not produce serving delivery metrics; metric behavior is covered with deterministic mocked provider fixtures until a populated live customer is available.
- Stride exposes stable Google asset entities and PMax asset-group relationships, but does not claim normalized asset-level delivery metrics where Google evidence does not support truthful parity.

These limitations do not change the canonical hierarchy or provider-neutral frontend contract. The frontend should display them as data-quality/provider-capability limitations rather than synthesizing parity that Google does not expose.
