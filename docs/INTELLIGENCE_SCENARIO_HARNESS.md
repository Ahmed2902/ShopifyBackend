# Intelligence scenario harness

This harness exists to validate Stride V1's deterministic decision engine against deliberately constructed scenarios without pretending that Meta Sandbox can generate real delivery history.

## Why the harness is split in two

Meta Sandbox is useful for provider integration behavior: OAuth, account discovery, hierarchy sync, currencies/time zones, creatives, ads, and tracking parameters. Sandbox ads do not produce realistic spend, impressions, purchases, ROAS, CPA, or fatigue history.

Recommendation validation therefore uses normalized synthetic evidence shaped exactly like the evidence that Stride's repositories produce after Meta + Shopify synchronization. Service-level scenario tests then pass that evidence through the real metric builders, data-quality layer, rules, ranking, and deterministic decision mapper.

This gives us two independent proofs:

1. Meta Sandbox proves provider plumbing.
2. The scenario harness proves deterministic decision semantics.

A real merchant ad account with historical delivery remains the final pre-production validation of both layers together.

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

## Meta Sandbox seeding

The Meta seeder is a provider-plumbing utility, not a recommendation-data generator. It creates only PAUSED campaigns, ad sets and ads, and it must never be pointed at a live merchant account. Existing campaigns, ad sets, creatives, and ads are discovered across all Graph API pages before the seeder decides whether anything is missing, so rerunning it does not create duplicates merely because an existing object sits beyond the first page.

For sandbox creatives, prefer `META_SANDBOX_IMAGE_URL` set to a public HTTPS image. The seeder sends that URL directly as `object_story_spec.link_data.picture`; it does **not** call `/{ad-account}/adimages`. Some Meta sandbox/test apps return OAuthException code 3 for the ad-image upload endpoint even though campaign, ad-set, creative and ad creation are available. If you already have a valid Meta ad image hash, `META_SANDBOX_IMAGE_HASH` is still supported and takes precedence.

Always inspect the target first with the read-only dry run:

```bash
npm run dev:meta-sandbox-seed:dry-run
```

Write mode requires two independent confirmations: an explicit acknowledgement embedded in the dedicated npm script and a second copy of the exact target account ID. The confirmation ID accepts either the numeric form or the same `act_` form as the target.

```bash
export META_SANDBOX_AD_ACCOUNT_ID=act_123456789
export META_SANDBOX_CONFIRM_AD_ACCOUNT_ID=act_123456789
export META_SANDBOX_IMAGE_URL=https://example.com/public-test-image.jpg
npm run dev:meta-sandbox-seed:write
```

The dedicated dry-run/write scripts avoid npm treating custom `--...` arguments as npm configuration. The command refuses write mode when `NODE_ENV=production`, refuses writes without the internal `--confirm-sandbox-write` acknowledgement, and refuses writes unless `META_SANDBOX_CONFIRM_AD_ACCOUNT_ID` exactly matches the normalized target account ID. Use the dry run first every time and never use production merchant credentials.

## Safety / environment rules

Scenario code must not:

- contain Meta access tokens;
- run against production data automatically;
- mutate live merchant ad accounts;
- claim synthetic evidence came from Meta;
- turn deterministic V1 output into AI/ML claims.

Use Meta Sandbox for write-path integration tests and synthetic repository evidence for recommendation scenarios until a consenting real test merchant account is available.
