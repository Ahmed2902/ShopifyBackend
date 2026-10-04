# Metrico combined release — 2026-10-04

This release incorporates the existing conversion-signals and Shopify billing/lifecycle work and the local-development rate-limit fallback. No PR is merged automatically.

## Changes
- Rebrands merchant UI, email, extensions and documentation to Metrico while preserving existing protocol identifiers, event IDs, storage keys, MCP tool names and extension UIDs.
- Discovers directly owned, enabled Google Ads Purchase import actions from the store's selected non-manager accounts. Requires the current Google OAuth Data Manager scope, verifies eligibility again at activation and never asks merchants for API keys. Provider delivery continues to recheck consent and connection credentials.
- Groups catalog mappings by provider/store/catalog before preparing conversion claims, retaining exact and ambiguous match behavior.
- Updates vulnerable dependencies. Backend full and production audits: zero vulnerabilities at the recorded check. Frontend production audit: zero; five high findings remain in the development-only braces/micromatch lint chain, with no patched braces release available at this check. Do not run untrusted glob input through that toolchain. CI gates high/critical production findings.

## Measured performance
100 claims across 100 stores, 30 items each and 3,000 catalog mappings; 20 measured samples after warmup; mocked database I/O. Median conversion preparation CPU fell from 8.073 ms to 3.423 ms (57.6% reduction). Outputs are deeply equal. This measures preparation CPU, not provider delivery or production database latency. Pool-budget guards remain enforced.

## Local verification
`npm run ci`: lint, TypeScript, 193 passing test files / 1,056 passing tests, smoke-script syntax and pool-budget self-test. 38 database-dependent files / 112 tests are skipped locally because this workspace has no PostgreSQL. The PR workflow is the required gate for database-enabled tests, 53 migrations, migration drift and Docker.

## Provider and submission limits
Google OAuth verification, developer token access, actual selected accounts/actions and live acknowledgement need account evidence. Only enabled UPLOAD_CLICKS/PURCHASE actions owned by the selected customer qualify. Website-tag and manager-owned actions are intentionally excluded.

TikTok investigation confirms a Marketing API pixel-list endpoint and a separate Events API event endpoint. Existing advertising authorization does not prove authority to send storefront events. Managed TikTok setup remains unavailable until an approved Events API token acquisition/refresh and revocation flow is verified. Existing manually configured server destinations remain unchanged.

Shopify review was refreshed from the canonical CLI checklist. Theme app extension requirements now apply: 21 likely passing, 13 need live/account/listing review, 0 observed failures across 34 applicable requirements. This is code evidence, not Shopify approval. Live installation, incognito App Bridge, billing, protected-data approval, extension deployment, TLS and listing/reviewer credentials remain launch gates.

## Primary references
- https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access
- https://developers.google.com/google-ads/api/fields/v25/conversion_action
- https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/MeasurementApi.md
- https://business-api.tiktok.com/gateway/docs/index?doc_id=1771100779668482
- https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements

## Final PR review fixes
Customer redaction preserves withdrawal cutoffs until normal expiry and locks against Pixel insertion. Data exports include order-linked customer pseudonyms and conversion deliveries (including event-linked rows), remain scoped to the requested store and exclude destination credentials. Export creation also serializes against redaction so a stale read cannot recreate an erased export. The Meta browser loader can recover after errors/timeouts without injecting a competing script or taking over a third-party replacement. Database regressions cover delayed sharing after redaction and complete, isolated exports; browser-embed regressions cover recovery and ownership.
