# Analytics read workspaces

This module is Stride's stable analytics read side.

The pattern is intentionally CQRS-lite, borrowing the useful part of Systemly's workspace reads without coupling backend contracts to the current frontend layout:

- endpoints represent stable analytical resources or cross-domain use-cases, not cards, tabs or pages;
- a workspace composes data only when one analytical concept genuinely spans multiple source domains;
- Shopify and Meta remain the source domains; analytics does not create a second write model;
- mutations remain in the integration/domain that owns them;
- list/detail reads remain bounded and explicit;
- no generic query framework, event layer or recommendation persistence is introduced;
- the frontend may combine these endpoints differently as the UI evolves without forcing backend route churn.

The expected dependency direction for cross-domain reads is:

```text
route
  -> thin controller
    -> <UseCase>Workspace
      -> source/read repositories
        -> Prisma/provider facts
```

A workspace owns composition and methodology. A repository owns data access. Controllers do not calculate analytics. A workspace should not be created for a simple single-domain read that a normal service/repository already handles.

## Read contract

```text
Overview       GET /analytics/overview
Products       GET /analytics/products
Product        GET /analytics/products/:productId
Product × Ads  GET /analytics/product-ads
Product × Ads  GET /analytics/product-ads/:productId
Ad Exposure    GET /analytics/ad-exposure
Ad Exposure    GET /analytics/ad-exposure/:adId
Collections    GET /analytics/collections
Customers      GET /analytics/customers
Inventory      GET /analytics/inventory
Advertising    GET /analytics/advertising
Campaigns      GET /analytics/campaigns
Campaign       GET /analytics/campaigns/:campaignId
Ad Sets        GET /analytics/adsets
Ad Set         GET /analytics/adsets/:adSetId
Ads            GET /analytics/ads
Ad             GET /analytics/ads/:adId
Creatives      GET /analytics/creatives
Creative       GET /analytics/creatives/:creativeId
```

All routes are mounted below `/v1/stores/:storeId`.

`Overview` is a stable cross-domain summary: Shopify commerce, product economics, same-currency Meta spend, blended MER, contribution-after-ads and data availability are returned together.

`Product × Ads` is a separate cross-channel analytical resource. It keeps Shopify commerce truth, Meta provider attribution and Stride's mapping-derived metrics distinct. Only exact single-product mappings are used for product-level paid metrics; ambiguous multi-product ads are excluded rather than split or guessed.

`Ad Exposure` is the complementary scope-aware read. `AdExposureWorkspace` composes Meta ad facts with current Shopify target relationships and optional inventory context. It distinguishes exact product exposure, shared multi-product exposure, collection exposure, store-level exposure and unknown scope. For `MULTI_PRODUCT` and `COLLECTION`, Meta spend remains at ad level and is never divided between products unless a provider-level allocation fact exists.

## Evidence semantics

- Historical windows use the merchant's store timezone and compare against the immediately preceding equal-length period.
- Shopify demand is bucketed by `processedAt`, falling back to `shopifyCreatedAt`, across analytics and intelligence.
- Shopify `current` order totals are already current-state values after returns; overview does not subtract refunds a second time.
- Product economics net linked refund-line value. Restocked refunded units reverse COGS; non-restocked refunded units still consumed inventory cost.
- Product costs are time-matched to the same Shopify demand date used for historical bucketing.
- Meta purchase metrics use one prioritized purchase action family and prefer direct `ACTION_VALUE` evidence over ROAS-derived fallback value.
- Cross-channel economics never combine different currencies.
- Meta freshness is the latest persisted AD-level Insights sync across selected ad accounts, independent of the reporting window.
- Period reach is not reported from daily ad-level rows because reach is non-additive across rows. Frequency is an impression-weighted average of daily provider frequency and is used only as an observational repeat-exposure signal.
- `read_all_orders` authorization and successful history synchronization are separate facts. The legacy `fullOrderHistory` flag remains an authorization indicator for compatibility. `orderHistory.syncReady` means a successful `OrdersRefunds` sync exists, but the current `SyncRun` schema does not persist which history scope produced that run, so Stride does not claim independently verified all-time coverage (`fullCoverageVerified: false`).
- Collection historical metrics currently apply the collection's **current** product membership to historical order cohorts. This limitation is explicit as `membershipSnapshot: CURRENT`; Stride does not claim historical collection-membership reconstruction.
- Collection ad exposure likewise uses current Shopify collection membership. The response includes `CURRENT_COLLECTION_MEMBERSHIP` whenever that limitation matters.
- Shared multi-product/collection ads expose one ad-level spend value plus target membership. Product rows intentionally use `allocatedAdSpend: null` for shared scopes.
- Inventory days cover remains deterministic: current available inventory divided by recent observed stock-depletion velocity. It is not a forecast and only drives inventory recommendations when inventory is marked `TRUSTED`.
- Historical creative metrics retain facts from ads that were later soft-deleted; current entity lists still represent current active provider objects.

Source and methodology labels must remain explicit whenever Shopify truth, provider attribution and Stride-derived cross-channel calculations appear together.
