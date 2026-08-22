# Meta + Shopify data contract for intelligence

This document defines what the backend should collect before building forecasts or advertising recommendations. Provider payloads remain available in `rawJson` / `ExternalPayload`, while stable features are normalized into the Prisma domain model.

## Principle: never invent ad-to-product precision

A Meta ad is not assumed to target one Shopify variant.

The normalized targeting scopes are:

- `STORE` — general store / homepage advertising.
- `COLLECTION` — collection/category-level destination or creative.
- `PRODUCT` — one Shopify product, all variants.
- `PRODUCT_OPTION` — one product constrained by options, for example `Color=Black`, while size remains open.
- `VARIANT` — one exact Shopify variant.
- `MULTI_PRODUCT` — dynamic/catalog/carousel or other ad representing several products.
- `UNKNOWN` — evidence is insufficient.

`AdProductMapping` is many-to-many. A mapping stores its granularity, evidence source, confidence, optional catalog item, optional exact variant, and optional `optionSelector` JSON.

Examples:

```json
{
  "granularity": "PRODUCT",
  "product": "Blank Hoodie"
}
```

```json
{
  "granularity": "PRODUCT_OPTION",
  "product": "Blank Hoodie",
  "optionSelector": { "Color": ["Black"] }
}
```

```json
{
  "granularity": "VARIANT",
  "product": "Blank Hoodie",
  "variant": "Black / XL"
}
```

## Meta entity data to collect

### Ad account

Collect normalized account identity and finance/timezone context:

- account id and name
- status
- currency
- timezone name/id/offset
- amount spent
- balance
- spend cap
- raw provider response

### Campaign

Collect:

- id and name
- objective
- configured/effective status
- buying type
- bid strategy
- daily/lifetime budget where campaign-owned
- budget remaining and spend cap where exposed
- promoted object
- start/stop time
- provider created/updated timestamps
- labels/issues/recommendation fields in raw provider response

### Ad set

Collect:

- id/name/campaign relationship
- configured/effective status
- daily/lifetime budgets and spend caps where ad-set-owned
- bid strategy / bid amount / bid constraints
- billing event
- optimization goal
- destination type
- dynamic-creative flag
- complete targeting JSON
- promoted object
- attribution specification
- learning-stage information
- schedule

Targeting JSON is retained because it can contain geography, demographics, platforms, placements, devices, custom/lookalike audiences, interests/behaviors, dynamic/product audience configuration, and exclusions. These are useful context features but should not be expanded into dozens of first-class columns until the intelligence layer proves it needs them.

### Ad

Collect:

- id/name
- campaign/ad-set/creative relationships
- configured/effective status
- conversion domain
- source ad id when applicable
- tracking/conversion specifications
- provider recommendations/issues/labels
- provider timestamps
- derived target scope + confidence + evidence

The derived target scope is application evidence, not a claim that Meta always supplies a direct Shopify SKU reference.

### Creative

Collect the fields that can explain what is being advertised:

- creative id/name
- title/body
- CTA and CTA type
- image / thumbnail / video identifiers
- link URL / deep link / object URL
- object story ids/spec
- effective Instagram media id
- Instagram permalink
- product set id
- product data
- asset feed spec
- degrees-of-freedom spec
- template URL/spec
- URL tags
- all destination URLs extracted from nested creative assets
- raw provider response

Creative evidence is important because normal ads may only reveal product intent through destination URLs, URL tags, creative text, or asset-feed entries.

### Catalog + catalog item

When the merchant has a Meta catalog, collect:

- catalog identity/business ownership
- catalog counts
- item id
- retailer id
- retailer product group id
- parent product id
- name/brand
- availability
- price/sale price/currency
- size/color/pattern
- URL
- product type
- custom labels
- feed id
- quantity-to-sell-on-Facebook
- status/visibility

Catalog-item-to-Shopify-variant mappings remain many-to-many evidence with confidence. Retailer id/SKU and URLs are high-value deterministic mapping candidates.

## Meta Insights to collect daily

Use daily facts as the main ML/reporting grain. Store account/campaign/ad-set/ad ids plus optional product breakdown values.

Stable scalar facts:

- spend
- social spend when returned
- impressions
- reach
- frequency
- clicks
- unique clicks
- outbound clicks
- unique outbound clicks
- inline link clicks
- inline post engagement
- CPC
- CPM
- CPP
- CTR
- estimated ad recallers/rate when returned
- objective
- optimization goal
- attribution setting
- action report time

Flexible response groups are retained as JSON/action rows rather than forcing unstable provider schemas into columns:

- actions
- unique actions
- action values
- cost per action
- cost per unique action
- conversions
- conversion values
- purchase ROAS / website purchase ROAS
- website CTR response groups
- video-play/view metrics
- attribution windows
- action destination
- arbitrary breakdown JSON

### Product-level Insights

Where Meta accepts `breakdowns=product_id`, persist the provider product id breakdown separately from any normalized catalog/Shopify mapping. Do not assume the returned value is already a Shopify variant id.

That means the feature path is:

`Meta insight product_id -> Meta catalog/product evidence -> Shopify product/option/variant mapping -> inventory + sales features`.

If product-level Insights are unavailable for an ad/campaign, use the ad-to-product mapping evidence and retain its confidence so downstream recommendations know the attribution is less precise.

## Shopify features used beside Meta

The Shopify ingestion already supplies the demand/supply side of the model. The intelligence feature layer should use:

### Product / variant identity

- product id/title/vendor/type/status
- variant id/title/SKU/options
- price and compare-at price where available
- product/variant create/update/delete timing

### Inventory

- available
- on hand
- incoming
- committed
- reserved
- damaged
- quality control
- safety stock
- location
- append-only inventory snapshots
- inventory change velocity
- restock events / replenishment timing when available

### Commerce

- order created/updated/cancelled timing
- line item product/variant
- quantity
- gross/net line money available in normalized order data
- discounts
- refunds and refunded quantities/value
- source name
- test-order flag (exclude fake demand)

From these facts derive, by product and where possible by option/variant:

- units sold/day
- rolling 1/3/7/14/30-day velocity
- revenue velocity
- baseline demand before/without strong paid pressure
- acceleration/deceleration
- days of stock cover
- projected stockout date
- sell-through
- refund rate
- stockout history
- replenishment frequency and lead-time estimates where evidence exists

## Initial model feature families

Do not start with a black-box model. First generate an auditable feature table with these groups.

### Supply state

- inventory by sellable scope
- days cover
- incoming inventory
- committed/reserved inventory
- replenishment evidence
- recent stockout/recovery behavior

### Demand state

- rolling unit/revenue velocity
- velocity slope / acceleration
- day-of-week and seasonality features
- organic/baseline estimate
- paid-period demand delta

### Paid-media state

- spend and spend change
- impressions/reach/frequency
- clicks/outbound clicks/link clicks
- CTR/CPC/CPM
- purchases/action values/ROAS where available
- campaign objective and optimization goal
- budget ownership and current budget
- creative/ad age
- learning status
- targeting/placement summary features

### Mapping quality

Every model row that joins Meta to Shopify must carry:

- target scope
- mapping granularity
- mapping source
- confidence
- merchant-confirmed flag
- whether mapping came from catalog evidence, destination URL, product breakdown, creative evidence, or inference

A low-confidence product inference must never be treated the same as an exact catalog/variant mapping.

## Recommended Meta backend implementation order

1. **Data-model hardening** — this PR.
2. Meta authentication/connection and selectable ad-account/catalog discovery.
3. Account/campaign/ad-set/ad/creative/catalog sync with raw-payload retention.
4. Daily Insights sync, including action rows and optional `product_id` breakdown jobs.
5. Ad-to-Shopify mapping resolver (catalog ids, URLs, URL tags, product handles, option values, creative text, then merchant confirmation for ambiguous cases).
6. Store-scoped Meta read APIs for the frontend.
7. Feature-table generation and rule-based SCALE/HOLD/REDUCE/PAUSE baseline.
8. Forecast/model training only after sufficient merchant history exists.

## UI implications

The frontend should display mapping precision rather than hiding it. Examples:

- `Blank Hoodie` — Product match · high confidence
- `Blank Hoodie / Black` — Color-level match · medium/high confidence
- `Blank Hoodie / Black / XL` — Exact variant match
- `Winter Collection` — Multi-product
- `Store campaign` — Store-wide
- `Unmapped` — needs review

This prevents the product from presenting a precise stock recommendation when the ad itself is only known at product or collection level.
