# Intelligence scenario harness

This harness validates Stride V1's deterministic decision engine against deliberately constructed scenarios without claiming that generated delivery history came from Meta.

## Why the harness is split in two

Recommendation validation uses normalized synthetic evidence shaped exactly like the evidence that Stride's repositories produce after Meta + Shopify synchronization. Service-level scenario tests then pass that evidence through the real metric builders, data-quality layer, rules, ranking, and deterministic decision mapper.

For end-to-end application testing, the local fixture writer can insert realistic Meta hierarchy and daily Insights rows beneath a real connected Stride store/ad-account identity. This exercises the same database reads, analytics, mappings, reports and intelligence paths as provider-imported rows while leaving the actual Meta API fetch path explicitly unvalidated.

This gives us two independent proofs:

1. Connected-account database fixtures prove normalized analytics/intelligence behavior without mutating Meta.
2. A consenting merchant account with real delivery history proves OAuth, discovery and provider fetching against real Meta data.

## Commands

Run the exhaustive scenario matrix:

```bash
npm run test:intelligence-scenarios
```

Print a human-readable decision report:

```bash
npm run dev:intelligence-scenarios
```

Print the same report as JSON:

```bash
npm run dev:intelligence-scenarios -- --json
```

## Current rule matrix

| Rule ID | Required signal | V1 action |
| --- | --- | --- |
| `campaign_efficiency_deterioration` | Spend expands while Meta ROAS/CPA deteriorates with >=1,000 impressions in both 7-day periods | HIGH -> `REDUCE`; MEDIUM -> `HOLD` |
| `creative_fatigue_symptoms` | Frequency rises, CTR falls, and conversion efficiency weakens with >=1,000 impressions in both periods | `TEST` |
| `underexposed_commerce_winner` | >=5 Shopify units, >=0.70 exact mapping confidence, >=8% revenue share, paid share <60% of revenue share | `TEST` |
| `paid_commerce_exposure_mismatch` | Meaningful Shopify/Meta support, >=0.70 exact mapping confidence, >=8% mapped spend share, paid share materially exceeds revenue share | `INVESTIGATE` |
| `provider_roas_margin_trap` | >=80% cost coverage, provider ROAS >=1.5, but contribution after ads <=0 | `REDUCE` |
| `inventory_spend_conflict` | Merchant-trusted inventory, positive mapped spend + sales velocity, 0-10 days current stock cover | `HOLD` |
| `shared_exposure_inventory_conflict` | Shared multi-product/collection ad has spend + >=1,000 impressions and exposes at least one trusted-inventory product with <=10 days cover | `HOLD` |

`SCALE` and `PAUSE` are valid `DecisionAction` values but no current V1 rule emits them. Tests should not fabricate those outcomes until a deterministic rule is added for them.

## Coverage in `intelligence.scenario-matrix.test.ts`

The rule matrix includes:

- positive paths for every current rule ID;
- both HIGH and MEDIUM campaign severity/action branches;
- HIGH and MEDIUM direct-inventory severity branches;
- zero-Shopify-sales mismatch with strong paid evidence;
- multi-product and collection shared-exposure variants;
- HIGH, MEDIUM and LOW confidence paths;
- exact threshold suppression around impressions, spend growth, ROAS, CPA, frequency, CTR, mapping confidence, mapping coverage, cost coverage, provider ROAS, inventory trust, stock cover and shared-scope confidence;
- merchant-confirmed shared-scope override;
- a benchmark-informed Meta deterioration scenario.

## Full snapshot scenario

`intelligence.service.scenarios.test.ts` does not hand the rules precomputed evidence. It mocks the normalized repository outputs instead:

- Meta current/comparison evidence rows;
- Shopify product commerce aggregates;
- current inventory aggregates;
- exact product-ad mappings;
- one ambiguous shared multi-product mapping;
- active Shopify + Meta integration context.

The real `IntelligenceService.snapshot()` then has to derive and emit all seven current rule IDs in one snapshot. The test also verifies global mapping coverage, cost coverage, shared exposure, deterministic actions, confidence, stale-data limitations, and severe mapping-quality degradation.

The synthetic store intentionally uses GBP and a 90% exact mapping-coverage baseline so clean recommendation scenarios are not accidentally degraded by data-quality warnings.

## Benchmark-informed scenario

The benchmark profile is based on Triple Whale's August 18, 2026 Meta ecommerce benchmark report covering more than 40,000 brands from August 1, 2025 through July 31, 2026:

- median Meta CPA: **$38.99**
- median Meta CPM: **$15.06**
- median Meta ROAS: **1.88**
- median Meta CTR: **2.39%**
- Meta share of measured ecommerce ad budget: **66.88%**

Source: https://www.triplewhale.com/blog/facebook-ads-benchmarks

The harness reconstructs a coherent comparison period around those public aggregate medians, then creates a synthetic current period where spend rises while ROAS, CPA and CTR materially deteriorate. That should produce a HIGH `campaign_efficiency_deterioration` recommendation with action `REDUCE`.

These public benchmarks are **not** merchant-level ground truth and are never used by the production recommendation engine. They are only realistic test inputs.

## Confidence scenarios

Product mapping coverage is global, not per-product:

```text
exact mapped same-currency Meta spend / total same-currency Meta spend
```

That means intentionally lowering mapping coverage can affect multiple product recommendations. The harness therefore tests degraded confidence separately from the clean all-rules scenario.

Expected behavior:

- coverage >=60%: no mapping-coverage limitation;
- coverage 30%-60%: `MAPPING_COVERAGE_PARTIAL` and reduced confidence;
- coverage <30%: `MAPPING_COVERAGE_VERY_LOW`, a severe limitation, and LOW confidence in the constructed scenario.

## Inventory semantics

Inventory recommendations only exist when the merchant has explicitly selected trusted inventory mode. `daysCover` is current stock divided by recent observed depletion velocity. It is a runway indicator, **not a stockout forecast**.

Shared-ad recommendations keep Meta spend at the ad level. They intentionally add `SHARED_SPEND_NOT_ALLOCATED` rather than inventing product-level spend allocation.

## Connected-account Meta fixtures

`meta-fixture-seed.ts` creates normalized database fixtures only. It never calls Meta and never writes campaigns, ads, creatives or budgets back to a provider account.

The fixture target must already be a real connected Stride store and a selected `MetaAdAccount`. Preview the exact target before any write:

```bash
META_FIXTURE_STORE_ID=<store-uuid> \
META_FIXTURE_AD_ACCOUNT_ID=act_123456789 \
META_FIXTURE_CONFIRM_AD_ACCOUNT_ID=act_123456789 \
npm run dev:meta-fixtures
```

Write realistic fixture hierarchy, mappings and 60 days of daily ad-level Insights:

```bash
npm run dev:meta-fixtures:write
```

Remove only generated rows:

```bash
npm run dev:meta-fixtures:cleanup
```

Every generated provider-facing ID and Insight key begins with `stride_fixture_`. Fixture rows also carry `rawJson.fixture=true` where the model supports raw provider evidence. Cleanup targets that namespace and leaves the real `MetaConnection`, real `MetaAdAccount`, Shopify data, and future provider-imported Meta rows untouched.

The fixture scenarios include healthy growth, severe efficiency deterioration, video creative fatigue/retention decay, shared multi-product exposure, deliberately missing mapping coverage, product mappings and collection mappings. This is intended to exercise the application after provider ingestion, not to claim the provider fetch itself was tested.

The writer refuses `NODE_ENV=production`, requires the exact store/account target, and requires a second confirmation account ID before `--write` or `--cleanup` can execute.

## Safety / environment rules

Scenario and fixture code must not:

- contain Meta access tokens;
- call Meta write APIs;
- mutate live merchant ad accounts;
- claim synthetic evidence came from Meta;
- overwrite the real Meta connection/account identity;
- turn deterministic V1 output into AI/ML claims.

Use connected-account database fixtures for normalized V1 testing. Validate Meta OAuth/discovery/fetching separately against a consenting merchant account with real delivery history.
