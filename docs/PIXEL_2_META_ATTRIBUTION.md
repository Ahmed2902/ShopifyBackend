# PIXEL-2A — Exact Meta attribution bridge

This phase adds the deterministic bridge between Meta ad identity and Stride first-party storefront events.

## Truth boundary

Shopify Web Pixels tell Stride what happened on the storefront. Meta ad identity is not supplied by Shopify automatically. Exact ad identity therefore enters the storefront through URL parameters attached to the Meta ad destination.

Stride stores that identity as observed attribution evidence. It does **not** mean the ad causally caused a later purchase.

## Tracking parameters

Stride uses Meta dynamic URL parameters:

```text
stride_meta_campaign_id={{campaign.id}}&stride_meta_adset_id={{adset.id}}&stride_meta_ad_id={{ad.id}}
```

At click time Meta resolves those macros to provider IDs. The Stride Pixel allowlists the resolved numeric values and sends them as:

- `metaCampaignExternalId`
- `metaAdSetExternalId`
- `metaAdExternalId`

The raw query string is still removed before event storage.

Unresolved macros and non-numeric values are ignored by server-side URL extraction and rejected if submitted directly in the structured attribution object.

## Multiple paid touches

The Shopify Web Pixel keeps the current attribution context in session storage. If a later page load contains a new allowlisted attribution payload, that newer inbound touch becomes the active context for subsequent events.

This preserves raw evidence for a journey such as:

```text
Meta Ad A -> browse -> leave/re-enter through Meta Ad B -> checkout
```

The later session/journey read model can interpret first touch, last touch, and assisted paths without rewriting the raw event evidence.

## Setup modes

### Manual — no Meta write permission

The merchant can keep the Meta connection read-only and paste the generated URL-parameter template into Meta Ads Manager.

Endpoint:

```text
GET /v1/stores/:storeId/integrations/meta/tracking/manual
```

### Automatic — optional `ads_management`

The base Meta connection remains read-only (`ads_read`). The merchant explicitly starts a second OAuth flow when they choose automatic setup:

```text
POST /v1/stores/:storeId/integrations/meta/tracking/permission
```

That flow requests:

```text
ads_read,ads_management
```

The requested authorization mode is signed into OAuth state. The callback only completes an automatic-tracking upgrade when Meta's inspected token actually contains `ads_management`. If the merchant declines that permission, Stride returns `META_ADS_MANAGEMENT_REQUIRED` and leaves the existing read-only connection untouched instead of reporting a false successful upgrade.

Audit coverage:

```text
GET /v1/stores/:storeId/integrations/meta/tracking
```

The audit reports exact, partial, and missing tracking coverage per synced ad and always returns the manual fallback.

Apply or dry-run:

```text
POST /v1/stores/:storeId/integrations/meta/tracking/apply
```

Example dry-run body:

```json
{
  "adIds": ["123456789"],
  "dryRun": true
}
```

## Mutation safety

Automatic setup is merchant-triggered and limited to tracking configuration.

Stride does not change:

- budgets
- bids
- targeting
- schedules
- campaign/ad-set/ad status
- creative media or copy intentionally

Meta creatives are handled conservatively because URL tags live on the creative. For supported non-dynamic creatives, Stride clones the creative with existing merchant URL tags plus the Stride tracking parameters, then repoints the selected ad to the new creative.

Stride does not automatically retry provider writes because creative creation is non-idempotent. A lost response could otherwise create duplicate creatives.

Dynamic or unsupported creative shapes are returned as `MANUAL_REQUIRED` and are never automatically rebuilt.

Meta can review an ad again after a creative assignment. API responses explicitly surface that warning, and successful writes request a normal Meta hierarchy resync before Stride treats the local snapshot as current.

## Meta developer configuration required for production

Code can request `ads_management`, but Meta must also allow the app to request/use it for merchant ad accounts.

For production customer accounts, configure the Meta app so `ads_management` has the appropriate access level in **App Dashboard -> App Review -> Permissions and Features**. Keep `ads_read` as the base permission. The exact dashboard labels can change; Meta renamed the old Ads Management Standard Access feature to **Marketing API Access Tier** in May 2026.

Until Meta grants the production access required for other businesses' ad accounts, automatic setup may work only with developer/test-owned assets. Manual setup remains fully available.

## Deferred

- exact Google/TikTok setup
- any budget/bid/status automation
