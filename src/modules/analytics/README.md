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

All historical reads share the same store-local current/comparison window semantics. Source and methodology labels must remain explicit whenever Shopify truth, provider attribution and Stride-derived cross-channel calculations appear together.
