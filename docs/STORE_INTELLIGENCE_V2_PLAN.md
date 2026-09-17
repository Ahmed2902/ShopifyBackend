# Stride Storefront & Commerce Intelligence V2

This PR extends the existing deterministic intelligence architecture without introducing AI/ML or a second analytics model.

## Scope

- complete Pixel funnel semantics with explicit cart/checkout abandonment and largest funnel leak
- feed storefront behavior into the deterministic intelligence snapshot
- add storefront deterioration rules with evidence thresholds and confidence
- add commerce deterioration rules for refunds, discounts and returning-order health
- add ad-set/ad efficiency and video-retention rules where existing provider evidence is sufficient
- add mapping/data-health intelligence for degraded coverage/high unmapped spend
- preserve existing source labels, currency isolation, mapping semantics and recommendation lifecycle

## Explicitly out of scope

- LTV/cohorts
- forecasting
- semantic creative analysis
- causal attribution/incrementality
- ML
- arbitrary shared-spend allocation
