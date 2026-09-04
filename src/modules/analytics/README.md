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

## Read contract

```text
Overview       GET /analytics/overview
Products       GET /analytics/products
Product        GET /analytics/products/:productId
Product × Ads  GET /analytics/product-ads
Product × Ads  GET /analytics/product-ads/:productId
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
- Historical creative metrics retain facts from ads that were later soft-deleted; current entity lists still represent current active provider objects.

Source and methodology labels must remain explicit whenever Shopify truth, provider attribution and Stride-derived cross-channel calculations appear together.
