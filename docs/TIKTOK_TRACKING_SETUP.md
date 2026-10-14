# TikTok tracking setup

## Release order

1. Merge and deploy the backend. The migration adds four nullable TikTok URL
   identifier columns to storefront events and session touches. It does not
   infer or backfill attribution. Existing retention, withdrawal and redaction
   remove the same event/session records, including the new identifiers.
2. Copy `extensions/stride-pixel/src/index.js` to the existing `metrico-pixel`
   Shopify CLI project and deploy that extension with its existing UID. Deploy
   the backend first because the collector validates attribution fields strictly.
3. Merge and deploy the frontend. The TikTok integration gains manual templates,
   synced-ad coverage, ad selection, preview, installation and permission renewal.
4. After TikTok approves ad-update access, authorize the connected advertiser
   again. If `TIKTOK_SCOPES` explicitly restricts authorization, include the exact
   approved permission identifiers shown by TikTok; do not assume Meta-style
   named scopes or that configured scopes prove the merchant granted write access.

No additional Shopify customer-data permission is used. TikTok itself checks
ad-update access when a mutation is submitted. The panel never labels configured
or inferred scopes as granted write permission.

## Manual configuration

Standard template:

```
metrico_tiktok_campaign_id=__CAMPAIGN_ID__&metrico_tiktok_adgroup_id=__AID__&metrico_tiktok_creative_id=__CID__
```

Upgraded Smart+ also includes `metrico_tiktok_ad_id=__ADID_V2__`. TikTok's `__CID__`
is a creative identifier, not an upgraded Smart+ ad bundle identifier. Automatic
setup adds the known campaign, ad group and ad IDs from the selected synced ad,
plus the dynamic creative identifier. Existing merchant UTMs remain unchanged.
Only expanded numeric identifiers are collected; literal macros are discarded.
Observed identifiers do not prove platform attribution or customer matching.

## Automatic setup contract

Owner/admin only, subject to the TikTok billing entitlement:

- GET `/stores/:storeId/integrations/tiktok/tracking/manual`
- GET `/stores/:storeId/integrations/tiktok/tracking`
- POST `/stores/:storeId/integrations/tiktok/tracking/apply`

Preview input: `{ "adIds": ["123"], "dryRun": true }`. A successful preview
returns a signed ten-minute `previewToken`. Apply requires exactly those IDs,
`dryRun: false` and that token. Store, connection and advertiser identity are
bound to the token. Live URL/parameter snapshots are checked immediately before
writing. Unsupported or failed previews cannot be installed as a batch.

Standard ads use `ad/get` and `ad/update` with `patch_update: true`, sending only
ad identity and the amended landing URL. Upgraded Smart+ uses its separate get
and update endpoints and replaces only the complete existing landing URL list.
No creative, campaign budget, bid, audience or delivery status is submitted.
Legacy dynamic/ACO and signed destinations remain manual. Platform UTM fields
are preserved; conflicting owned identifiers in those fields require manual
setup. Every successful write is read back. Unverified or uncertain writes are
reported as failures, without automatic mutation retries. Refresh/sync before
retrying. Ads may enter platform review after URL changes.

Coverage uses synced metadata, up to 1,000 selected-advertiser ads, and explicitly
reports truncation. Sync TikTok after installation to refresh local coverage.
Installation batches contain at most 50 explicitly selected ads.

## Validation

Use approved TikTok ad-update access with a paused standard website ad and, when
available, an upgraded Smart+ ad. Preview, review the URLs, install and sync.
Confirm only Metrico parameters changed, existing UTMs remain, and coverage says
installed. Click a real ad later to verify macro expansion and campaign identity.
A synthetic URL journey verifies collector plumbing but not genuine ad attribution.
Repeat installation to confirm the existing setup is skipped. Change an ad URL
between preview and apply to verify stale previews cannot overwrite it.

API shapes are based on TikTok's official SDK:
https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/AdUpdateBody.md
https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/AdupdateCreatives.md
https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/SmartPlusAdUpdateBody.md

Macro definitions:
https://ads.tiktok.com/resources/help/article/track-offsite-web-events-with-utm-parameters

Automated tests cover request shapes and readback behavior with mocked TikTok
responses. Live ad editing remains unverified until the requested permission is
approved and a supported ad is available; endpoint existence does not establish
that every ad format or account is eligible.
