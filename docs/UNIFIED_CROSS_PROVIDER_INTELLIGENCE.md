# Unified cross-provider intelligence

Parent: `b7e6597a37b8f91d3dc48da57f5bd8b28b4004c5` (`#129`).

This document is the backend contract for Stride's provider-neutral intelligence layer. It does not change provider ingestion or the canonical `Advertising*` model.

## Truth model

- **Shopify is commerce truth**: orders, net revenue, refunds, products/variants, customers, inventory, product economics, contribution before advertising.
- **Meta, TikTok and Google Ads are provider-reported advertising evidence**: spend, delivery, clicks, provider-attributed conversions/value and provider ROAS.
- **Stride Pixel is first-party observed storefront evidence**: sessions, product/cart/checkout behavior, linked purchase behavior, landing/source evidence and observed journeys.
- **Stride intelligence is deterministic interpretation** of those sources.
- Provider conversion value is never relabeled as Shopify revenue.
- Missing evidence is never coerced to zero.
- Cross-provider spend is combined only when account/metric currency is compatible.
- Shared, ambiguous or unsupported product allocation is never guessed onto products.
- Pixel evidence is correlation/observation, not causal proof.

## Phase-A audit

| Merchant question | Before this PR | This PR |
| --- | --- | --- |
| Shopify net revenue, refunds, orders, units, AOV, new/returning | DONE | Reused as commerce truth |
| Contribution before ads | DONE | Reused |
| Total paid spend across Meta/TikTok/Google | MISSING | DONE, currency-safe |
| Spend by provider/account | PARTIAL | DONE |
| Campaign/group/ad provider-neutral reads | PARTIAL | DONE |
| Provider conversions/value/ROAS | PARTIAL | DONE, explicitly provider-attributed |
| CTR/CPC/CPM | PARTIAL | DONE, deterministic from common counters |
| Campaign/group/ad deterioration | META-SHAPED/PARTIAL | DONE for common provider-neutral evidence with deterministic sample gates |
| Product mapped spend across providers | META-ONLY | DONE where exact mapping evidence exists |
| Shared/ambiguous/unmapped spend | PARTIAL | DONE; never allocated directly |
| Google PMax/Shopping product allocation | UNSAFE if guessed | Explicitly unavailable/shared/unmapped unless canonical exact mapping exists |
| Product contribution after ads | META-ONLY/PARTIAL | DONE only with complete exact mapped same-currency evidence |
| Product inventory pressure from paid demand | PARTIAL | DONE using existing inventory evidence/trust rules |
| Pixel product/cart/checkout evidence | DONE | Reused in Product × Ads interpretation |
| Paid-media + Pixel causal claims | UNSAFE | Explicitly correlation-only |
| Cross-provider deterministic recommendations | MISSING | DONE with bounded entity/product evaluation |
| Deterministic confidence | PARTIAL | DONE as LOW/MEDIUM/HIGH rubric, not probability |
| Provider/account/currency/date data quality | PARTIAL | DONE on unified surfaces |
| Pixel/mapping/commerce-history quality | PARTIAL | DONE through the shared unified data-quality service |
| Missing same-currency evidence | PARTIAL | DONE; blended economics fail closed |
| Period reach | UNSAFE if summed | Explicitly unavailable |
| Unified MCP Product × Ads / decisions | LEGACY/PARTIAL | DONE through the same shared services used by HTTP |

## HTTP contracts

All routes are under `/v1/stores/:storeId/analytics` and preserve legacy endpoints during frontend migration.

### Filters

Unified range reads accept:

- `provider=ALL|META|TIKTOK|GOOGLE_ADS` (default `ALL`)
- `accountId=<canonical AdvertisingAccount UUID>`
- `currency=<ISO-4217 3-letter code>`
- `days=1..365`, or paired `from=YYYY-MM-DD&to=YYYY-MM-DD`

List reads additionally accept `page>=1` and `limit=1..100`.

`accountId` is validated against the current store's merchant-selected account set and against the requested provider. Cross-store, unselected, or provider-mismatched accounts fail closed.

Advertising-channel entitlements are enforced in the shared provider scope, not only at the HTTP/MCP edge. Pro may evaluate all selected providers. Essentials `provider=ALL` narrows to its selected/sole advertising channel; explicit access to another provider/account fails through the canonical billing boundary, and a multi-connected Essentials store with no chosen channel must select one first.

### 1. Advertising overview

`GET /advertising/unified`

Returns current/comparison evidence by provider and by account, absolute and percentage changes, Shopify commerce truth, fail-closed blended economics, provider capabilities, deterministic data quality and truth/methodology metadata.

Common metrics: spend, impressions, clicks, CTR, CPC, CPM, provider conversions, provider conversion value and provider ROAS. Period reach is `null`/unavailable.

Provider conversion value may be aggregated only as explicitly provider-attributed evidence. It must never be presented as unique revenue.

### 2-5. Campaigns / Groups / Ads / Creatives-Assets

- `GET /advertising/unified/campaigns`
- `GET /advertising/unified/groups`
- `GET /advertising/unified/ads`
- `GET /advertising/unified/creatives`

The normalized hierarchy vocabulary is **Campaign -> Group -> Ad -> Creative/Asset**. `GROUP` preserves `AD_SET`, `AD_GROUP`, and `ASSET_GROUP` as capability/entity metadata. Providers may expose different creative/asset capabilities; unsupported metrics remain unavailable rather than synthesized.

Common deterioration signals use deterministic delivery gates: fewer than 100 current impressions is insufficient for a strong efficiency conclusion; comparison-based deterioration requires at least 100 impressions in both periods; HIGH confidence and the positive strong-efficiency signal require at least 1,000 impressions in both periods. These are evidence gates, not statistical probabilities.

### 6. Product × Ads

- `GET /product-ads/unified`
- `GET /product-ads/unified/:productId`

Returns Shopify economics, exact mapped paid-media evidence by provider, shared/ambiguous/unmapped accounting, canonical mapping evidence, Pixel product behavior, inventory state, contribution-after-ads when defensible, confidence and explicit limitations.

Direct product economics use only merchant-confirmed or sufficiently confident single-product mappings. Shared/collection/multi-product mappings stay unallocated. PMax/Shopping spend stays unmapped/shared unless canonical evidence supports an exact Shopify product mapping.

### 7. Home unified KPIs

`GET /unified/home`

Alias of the unified advertising/business overview contract so the frontend does not rebuild truth semantics.

### 8. Decisions

`GET /unified/decisions`

Returns deterministic recommendations with category, severity, suggested action, current/comparison evidence, evidence quality, deterministic confidence, limitations, affected entity identities and recommendation lifecycle state. Evaluation is bounded and the response reports when the evaluation set was truncated.

### 9. Data quality

`GET /unified/data-quality`

Returns explicit cross-source limitations from shared services, including:

- disconnected/unselected providers and account selection gaps
- stale, partial and failed provider syncs
- currency mismatch/unknown currency and missing paid-media evidence
- unavailable deduplicated period reach
- Pixel unavailable/stale and Pixel behavior/attribution rollup failures
- incomplete Shopify order-history evidence
- ambiguous mappings, unmapped spend and Google PMax/Shopping allocation limitations
- insufficient current/comparison delivery sample for entity conclusions
- a bounded-audit warning when entity-level quality inspection is truncated

The entity-level quality audit is bounded to 100 campaigns, 100 groups, 100 ads and 100 Product × Ads rows. If any total exceeds that bound the response reports `QUALITY_AUDIT_BOUNDED` instead of implying exhaustive coverage.

## Blended economics

All blended economics use **Shopify** numerator/economic truth and compatible provider spend only.

- `blended MER = Shopify net order value / complete same-currency paid-media spend`
- `ad spend ratio = complete same-currency paid-media spend / Shopify net order value`
- `contribution after advertising = Shopify contribution before ads - complete same-currency paid-media spend`

If a required selected account has missing period evidence or unknown currency, the affected metric is unavailable (`null`). Zero spend is not inferred from missing evidence. Mixed known currencies remain separate and do not contaminate the store-currency calculation.

## Confidence

Confidence is an enum, not a probability:

- **LOW**: required current evidence is absent/too small, data quality is blocked, mapping is incomplete, or required economics are unavailable.
- **MEDIUM**: current evidence is usable but comparison, freshness, sample size, mapping or another evidence dimension is limited.
- **HIGH**: current and comparison evidence are available, sample thresholds are met, and there is no blocking limitation relevant to the conclusion.

Existing numeric ranking weights used by the recommendation sorter are rubric weights only and are explicitly not probabilities.

## MCP / advisor contract

MCP and advisor reads consume the same unified services rather than calculating separate paid-media or Product × Ads answers. Google facts appear where the provider capability supports them, normalized hierarchy uses `GROUP`, provider attribution remains clearly separated from Shopify commerce truth, and missing evidence remains missing. MCP surfaces remain read-only and do not expose provider tokens/secrets, raw visitor journeys, or newly introduce customer PII.

## Performance contract

- Provider/account resolution and billing entitlement resolution are request-memoized.
- Meta/TikTok latest sync-state reads are bounded single-row connection/provider lookups.
- Overview facts are grouped in SQL by account/currency and queried concurrently by provider/period.
- Hierarchy reads are DB-paginated.
- Entity metrics are fetched set-wise for only the page's IDs.
- Product × Ads loads mappings, provider facts, commerce aggregates, inventory and Pixel evidence concurrently; it does not issue per-product DB queries.
- Decision evaluation is bounded to 100 campaigns, 100 groups, 100 ads and 100 products and reports truncation.
- Unified data-quality entity inspection is bounded to 100 rows per entity type and reports truncation.
- Cache keys include store, provider, canonical account, currency, date range and pagination identity.

## Remaining hard limitations

- Cross-provider deduplicated reach is unavailable.
- Provider-attributed conversions/value across providers are not unique Shopify purchases/revenue.
- Google PMax has no fabricated ad layer; asset-level delivery metrics are not invented.
- Creative/asset semantics remain provider-specific when the providers do not expose equivalent evidence.
- Pixel correlations do not establish causation.
- Product-level paid-media economics remain unavailable when mapping/evidence cannot defensibly allocate spend to one Shopify product.
