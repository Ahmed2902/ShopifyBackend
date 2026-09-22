# Canonical advertising read cutover

This checkpoint moves production Meta paid-media reads onto Stride's canonical advertising persistence while preserving current response contracts.

Validated/cut-over surfaces in this branch include advertising overview, entity list/detail metrics, Product × Ads mapping and metrics, Ad Exposure hierarchy/target mappings and metrics, deterministic intelligence campaign/creative evidence, ad-set intelligence, shared-exposure targeting, recommendation entity-name resolution, creative retention, performance trends, dashboard/report consumers and MCP's Meta provider adapter.

Provider-native Meta tables remain as rollback and provider-ingestion compatibility storage during the migration window. OAuth/configuration, provider synchronization, provider-specific mapping resolution and Pixel-to-Meta identity resolution may continue to use provider-native persistence because those concerns sit below the canonical analytics/intelligence boundary.

Production analytics, Product × Ads, Ad Exposure, recommendation decoration, intelligence and MCP paid-media reads must use canonical advertising persistence. Any remaining provider-native read in one of those application surfaces is treated as a blocker before this PR is marked ready.

The quality gate also mirrors legacy characterization fixtures into canonical facts, so parity tests validate the actual post-cutover storage contract instead of relying on provider-native rows being visible to canonical readers.
