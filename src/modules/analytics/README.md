# Analytics read workspaces

This module is Stride's page-oriented analytics read side.

The pattern is intentionally CQRS-lite, matching the useful part of Systemly's workspace reads:

- one simple read endpoint should be enough to render a page's initial state;
- cross-domain page data is composed in `analytics.workspace.ts`;
- Shopify and Meta remain the source domains; this module does not create a second write model;
- mutations remain in the integration/domain that owns them;
- list/detail reads stay bounded and paginated;
- no events, recommendation persistence, or generic query framework is introduced.

## Page contract

```text
Overview       GET /analytics/overview
Products       GET /analytics/products
Product        GET /analytics/products/:productId
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

`Overview` is the main workspace composition: Shopify commerce, product economics, same-currency Meta spend, blended MER, contribution-after-ads, and data availability are returned together. There is intentionally no separate profitability endpoint because profitability is part of the Overview page contract.

All historical pages share the same store-local current/comparison window semantics. Shopify commerce truth, Meta provider attribution, and Stride-derived cross-channel metrics must remain explicitly distinguishable.
