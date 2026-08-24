# Intelligence Architecture

The recommendation system affects merchant money. Its primary design goal is therefore **decision quality under uncertainty**, not recommendation volume.

A correct system must be comfortable returning **NO_RECOMMENDATION** when evidence is incomplete, stale, contradictory, poorly mapped, or economically ambiguous.

## Optimization target

Do not optimize for ROAS in isolation.

The long-term recommendation target is:

> maximize expected incremental contribution profit subject to inventory, data-quality, attribution, and downside-risk constraints.

A campaign with higher ROAS is not automatically the best place for the next dollar. Inventory, margin, demand, diminishing returns, campaign role, attribution quality, and opportunity cost all matter.

## Truth hierarchy

### Shopify

Shopify is the commerce truth for:

- actual orders
- actual refunds
- units sold
- product/variant prices
- inventory
- restocks
- known product costs

### Advertising platforms

Meta and TikTok provide attribution claims and delivery/performance evidence:

- spend
- impressions
- clicks
- attributed purchases/value
- campaign/ad hierarchy
- creative metrics

Provider-attributed purchases are never summed and treated as actual purchases.

### Product mapping

A financial recommendation that depends on inventory or product economics must have a sufficiently reliable ad -> product/variant mapping. Weak mapping is a blocker, not a reason to guess.

## Normalized evidence layer

Provider-specific persistence remains provider-specific. The intelligence layer normalizes only what is required for reasoning:

- Campaign
- Delivery Group
- Ad
- Creative
- Daily Metrics
- Product exposure/mapping
- Shopify commerce outcome
- Inventory state
- Unit economics
- Data freshness/coverage

The raw provider payload remains available for audit/debugging.

## Evidence windows

Features use multiple windows, not one snapshot:

- 1 day
- 3 days
- 7 days
- 14 days
- 30 days

A recommendation should not be based on a single good/bad day. Recent evidence must be checked against previous and longer windows.

The feature layer tracks observation coverage as well as totals so missing days cannot look like real zeroes.

## Financial readiness gates

Before producing SCALE or REDUCE, all material inputs must be ready.

Required evidence includes:

- HIGH statistical/data-volume confidence
- fresh Shopify data
- fresh provider data
- reliable product mapping
- known contribution economics
- known break-even economics
- known inventory runway
- stable observation period after material campaign changes
- campaign role that supports direct-response financial evaluation
- attribution quality sufficient for the decision
- Shopify demand signal that does not materially contradict the provider signal

If a required input is missing, return `NO_RECOMMENDATION` with explicit blockers.

## Unit economics

Financial decisions must be made against break-even economics, not generic ROAS constants.

Contribution economics should eventually include, where available:

- net selling price after discounts
- product/variant COGS
- refunds/returns
- payment/transaction fees
- fulfillment/shipping subsidy
- other variable order costs

For a mapped product mix, compute a weighted contribution margin before ad spend.

Break-even ROAS is derived from those economics rather than hardcoded globally.

If required costs are unknown, the system must not claim that a campaign is profitable merely because ROAS is above an arbitrary value such as 2.0.

## Attribution

Shopify answers: **what actually sold?**

Meta/TikTok answer: **what does this platform claim it influenced?**

Financial recommendations need an attribution-quality score based on the evidence available, such as:

- UTM coverage
- product/ad mapping quality
- temporal consistency with Shopify sales
- platform attribution window
- cross-platform overlap risk
- direct/organic share
- data completeness

Low or unknown attribution quality blocks strong budget recommendations.

## Campaign role

Campaigns must be compared and evaluated according to role.

Examples:

- prospecting
- retargeting
- retention
- catalog
- product launch
- brand/awareness

A brand campaign should not receive a purchase-ROAS pause/scale recommendation simply because a direct-response threshold was applied to it.

Unknown role is itself a confidence limitation.

## Deterministic layer before ML

The deterministic layer does four things:

1. normalize evidence
2. compute trusted features
3. detect blockers/contradictions
4. produce conservative candidate actions or abstain

It is not allowed to invent a budget percentage.

Current candidate actions are intentionally limited:

- NO_RECOMMENDATION
- HOLD
- SCALE
- REDUCE
- COLLECT_MORE_DATA
- REVIEW_MAPPING
- REPLACE_CREATIVE
- REVIEW_LANDING_PAGE

The deterministic layer should prefer HOLD/NO_RECOMMENDATION over a weak financial recommendation.

## Budget recommendation size

A future recommendation such as `+37%` must **not** be derived from a rule like:

`HIGH confidence -> larger percentage`.

Confidence tells us how much we trust an estimate. It does not tell us the optimal budget.

The budget size must come from an estimated response curve:

`budget change -> expected incremental conversions/revenue/profit`

The system should evaluate multiple candidate budget levels and estimate, for each one:

- expected incremental revenue
- expected incremental contribution profit
- probability incremental profit is positive
- downside estimate / lower confidence bound
- expected inventory impact
- expected marginal ROAS/CPA

Then choose the budget level with the best risk-adjusted expected incremental profit.

If uncertainty is too wide, abstain.

## Uncertainty and calibration

Model confidence must be empirically calibrated.

A reported 80% probability should be correct approximately 80% of the time on comparable historical cases.

Recommendation confidence must not be a decorative label generated from subjective rules.

Calibration should be measured separately by:

- platform
- campaign role
- merchant size/spend band
- product category when enough data exists
- data-quality tier

## Contradiction checks

Before a financial recommendation is surfaced, search for evidence against it.

Examples:

- provider ROAS rising while Shopify mapped-product demand falls
- strong ROAS but inventory runway is collapsing
- strong 1-day result but weak 14/30-day evidence
- good attributed performance after a recent budget/edit change with insufficient stabilization time
- provider conversion value inconsistent with Shopify sales
- strong campaign result but low mapping coverage
- high aggregate performance driven by one outlier day

Material contradictions reduce confidence or force abstention.

## Evaluation before trusting recommendations

No recommendation model should be considered production-trustworthy only because offline metrics look good.

Required evaluation stages include:

### Historical backtesting

Replay historical data using only information that would have been available at that time. Never leak future outcomes into features.

Measure whether recommendations would have improved contribution profit, not only ROAS prediction error.

### Shadow recommendations

Generate recommendations without presenting them as trusted merchant advice. Compare predicted outcomes with what actually happened.

### Recommendation-level metrics

Track at least:

- precision of SCALE/REDUCE direction
- expected vs realized incremental revenue/profit
- probability calibration
- false-positive financial recommendations
- false-negative missed opportunities
- performance by confidence tier
- abstention rate
- outcome by campaign role/platform

False confident recommendations deserve substantially more weight than simply failing to recommend.

## Recommendation audit trail

Every surfaced financial recommendation must be reproducible later.

Persist or reconstruct:

- feature snapshot/version
- data freshness
- mappings used
- unit economics used
- attribution assumptions
- inventory state
- model/rule version
- recommendation
- estimated outcomes and uncertainty
- blockers/contradictions considered
- timestamp

This lets us answer: **Why did the system tell this merchant to change spend?**

## Core safety principle

The system should optimize for **being right when it speaks**, not for always having something to say.

When the evidence does not justify risking merchant money, the correct recommendation is:

`NO_RECOMMENDATION`.
