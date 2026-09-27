# Recommendation public contract

This document records the focused public-contract change for deterministic Stride recommendations.

## Merchant-facing recommendation fields

Recommendation responses expose deterministic facts and lifecycle state. Public recommendation objects include:

- `finding` — title and factual summary
- `affectedEntity` — type, Stride id, provider/Shopify external id, and label when available
- `measuredValues` — the rule evidence used by Stride; `null` remains unavailable and `0` remains a genuine measured zero
- `comparisonPeriod` — current observation period and comparison period when the rule uses one
- `thresholdCrossed` — plain-language deterministic rule conditions that were satisfied
- `suggestedAction` / `decisionAction` / `decisionMessage`
- `attributionPrecision`, limitations, severity, rule identity/version, occurrence key and lifecycle state

The public contract no longer exposes recommendation `confidenceScore`, `evidenceQuality`, or `decisionConfidence`. Unified decision responses no longer expose `confidenceModel` or a data-quality confidence grade. Internal diagnostic/ranking support values may remain implementation details and must not be presented as probabilities or merchant-facing recommendation confidence.

## Emission rule

A recommendation is emitted only after both of these are true:

1. the deterministic rule threshold is crossed; and
2. the inputs required by that rule pass their completeness/freshness/compatibility checks.

Required evidence is withheld rather than converted to zero when it is missing or partial. Provider-reported conversion/value evidence remains provider attribution; Shopify remains commerce truth. Cross-domain product conclusions require same-currency evidence and exact or merchant-confirmed product mapping. Stale evidence beyond the applicable 48-hour operational freshness window suppresses the affected conclusion.

Data-quality diagnostics remain available separately to explain why a conclusion was withheld.

## Frontend migration

Frontend recommendation components should stop reading or rendering:

- `confidenceScore`
- `evidenceQuality`
- `decisionConfidence`
- unified response `confidenceModel`
- unified `dataQuality.confidence`

Use `finding`, `affectedEntity`, `measuredValues`, `comparisonPeriod`, and `thresholdCrossed` to explain why Stride emitted the recommendation. Lifecycle controls continue to use the unchanged `occurrenceKey` and `lifecycleState` contract.
