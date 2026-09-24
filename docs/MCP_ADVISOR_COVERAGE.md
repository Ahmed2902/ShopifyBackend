# Stride MCP Advisor Coverage

This document is the production-readiness coverage map for Stride's read-only MCP advisor surface.
It distinguishes business knowledge that an external advisor may read from Stride from data and
operations that are intentionally not exposed.

## Design rules

- MCP is read-only. Tool schemas do not accept `storeId`; the store comes only from the OAuth token.
- Store membership is revalidated on each MCP request so revoked access does not survive until JWT expiry.
- The MCP route requires an active Stride subscription.
- Existing billing entitlements remain authoritative. In particular, advanced Pixel attribution remains Pro-only and recommendation counts respect the current plan limit.
- Shopify is commerce truth. Meta and TikTok conversion/value fields remain provider-attributed evidence.
- Stride Pixel is first-party observed storefront behavior and journey evidence, not causal proof.
- Stride's deterministic read models/rules remain authoritative for calculated metrics, evidence quality, confidence, limitations, and recommendation generation. MCP composes those reads; it does not create a second calculation engine.
- Currency boundaries are preserved unless an explicit Stride methodology says otherwise.
- Search is restricted to business entities and aggregate evidence; it is not a database or customer-PII search API.

## MCP tools and business coverage

| MCP tool | Covered Stride knowledge | Notes / boundaries |
| --- | --- | --- |
| `stride_get_context` | Store identity, domains, currency, timezone, integration state/freshness, truth-model metadata | OAuth-bound store only |
| `stride_get_snapshot` | Compact cross-domain overview, profitability/contribution context, safe dashboard signals, deterministic recommendations/data quality, derived Pixel funnel understanding, Product x Ads evidence | Recommendation array is plan-limited; optional domains remain explicitly unavailable when their read fails; raw recent-order records from the browser dashboard are removed from the advisor snapshot |
| `stride_search` | Shopify products/collections, Meta campaigns/ad sets/ads/creatives, TikTok campaigns/ad groups/ads, Pixel landing pages, Pixel attribution sources, Stride recommendations | No raw customer PII; paid-media search respects the active plan's allowed provider; TikTok creative is not claimed |
| `stride_get_commerce` | Commerce overview, daily performance, products/product detail, product leaderboard, collections/collection detail, aggregate customer analytics, inventory | Shopify-grounded; collection detail is a current membership snapshot, not reconstructed historical membership |
| `stride_get_paid_media` | Meta/TikTok overview/list/detail through the provider abstraction; Meta ad-exposure list/detail with deterministic Shopify target mapping and inventory context | Provider-attributed conversion/value remains distinct from Shopify truth; ad exposure is Meta-only; TikTok supports campaign/ad-group/ad detail, not creative parity; provider reads preserve channel entitlements without mutating billing selection |
| `stride_get_storefront` | Derived Pixel overview plus aggregate product, collection, and landing-page behavior | Uses the same derived cart/checkout abandonment and funnel-drop composition as Stride's HTTP UI |
| `stride_get_attribution` | Aggregate Pixel sources, Meta-ad first-party attribution evidence, journey paths, product/collection mapping evidence | Paths/mappings preserve `ADVANCED_ATTRIBUTION`; raw session/visitor journeys are not exposed |
| `stride_get_product_ads` | Product-centric Shopify x Meta mapped-spend/economics evidence | Shared/multi-product spend is not silently allocated as exact product spend |
| `stride_get_recommendations` | Deterministic recommendation lifecycle/evidence/quality/precision/limitations/confidence/data quality | Plan recommendation limit is enforced; no action execution |
| `stride_get_decision_settings` | Existing intelligence settings and inventory-planning settings used by deterministic rules | Read-only; exposes rule inputs such as inventory mode, restock lead time, and low-stock threshold, not setting writes |
| `stride_get_report` | Historical current-vs-comparison commerce/advertising report with deterministic intelligence context | Existing Stride report methodology is reused and the MCP response preserves the active plan's recommendation limit |

## Read models intentionally reused instead of recalculated

The advisor facade directly composes the existing Stride services/workspaces for analytics, paid-media
provider evidence, Product x Ads, ad exposure, Pixel behavior/attribution, intelligence, reports,
collection detail, product leaderboard, performance trends, and decision settings. Derived Pixel
funnel understanding is protocol-independent so the HTTP UI and MCP consume the same formulas.

This is intentional: MCP must never become an alternate metrics implementation whose answers can drift
from the first-party product.

## Intentional exclusions

### Customer/order PII and raw database access

MCP does not expose a generic SQL/database/query tool, arbitrary Prisma access, customer email/contact
search, or raw order/customer records. Aggregate customer analytics may be read through the commerce
surface because they are business intelligence rather than an identity lookup. The first-party browser
dashboard's recent-order preview is deliberately stripped from the broad MCP advisor snapshot.

### Raw Pixel sessions and visitor journeys

Stride's HTTP Pixel explorer can expose individual pseudonymous sessions and, where entitled, linked
visitor journeys. These are intentionally excluded from the generic external advisor surface. The MCP
advisor receives aggregate behavior and attribution evidence instead.

### Owner/admin-only Pixel operational endpoints

Pixel health/debug/install controls are not exposed through a generic store-scoped MCP token because
the first-party route applies stricter owner/admin authorization or performs an operational write.
Operational recovery remains a first-party Stride workflow.

### Writes and execution

MCP exposes no recommendation lifecycle mutation, campaign/ad mutation, inventory-setting write,
inventory-planning write, integration connect/disconnect, provider sync trigger, Pixel install/debug,
billing mutation, or other execution endpoint. Recommendations remain advice only.

### Unsupported provider parity

The provider abstraction reports its capabilities. Meta creative evidence is supported by the existing
Stride read model; TikTok creative parity is not claimed. The MCP layer must return/describe capability
limits rather than synthesizing missing provider functionality.

## Authorization and entitlement parity

The MCP transport/auth layer must preserve the effective restrictions of first-party Stride reads even
when it calls services below Express controllers:

1. OAuth access token is bound to one store/resource/client and requires `mcp:read`.
2. Store membership is checked again on each MCP request.
3. The `/mcp` route requires an active subscription.
4. Advanced Pixel attribution requires the existing `ADVANCED_ATTRIBUTION` entitlement.
5. Essentials paid-media reads honor its selected single advertising provider without auto-selecting or mutating that selection from a read-only MCP request.
6. Recommendation results are capped by the active plan's recommendation limit across dedicated recommendations, broad snapshots, search results, and MCP historical reports.
7. No caller-supplied store identifier exists in any tool input schema.

## Security and regression test matrix

The hardening test suite covers the boundaries most likely to diverge when MCP bypasses browser-facing controllers:

- OAuth authorization-code PKCE/client/redirect/resource validation, expiry, one-time claiming, and failed-validation non-consumption.
- Refresh-token client/resource binding and rotation/replay rejection.
- Client-ID metadata discovery protections for private/loopback targets, DNS resolution to private addresses, redirect rejection, fetch failures/timeouts, and bounded response size.
- MCP protocol modern/legacy compatibility, modern header/body routing mismatches, invalid parameters, notifications, response-size behavior, and OAuth-bound store routing.
- Per-request membership revalidation, active-subscription gating, provider entitlement parity, advanced-attribution gating, and recommendation limits.
- Read-only tool annotations and the absence of caller-controlled `storeId` or mutation tools.
- Shared Pixel derived funnel understanding, expanded business-entity search, exact TikTok detail reads, and explicit unsupported TikTok creative behavior.
- Snapshot plan limiting is tested with injected billing state so unit tests do not silently fall through to the real billing/database service.
- Snapshot privacy tests verify that browser-dashboard recent order identifiers/names do not leak into the external advisor payload.
- API discovery regression coverage includes the public `/mcp` endpoint advertisement alongside `/v1` and health routes.
- The pre-auth MCP rate limit is keyed by source address rather than untrusted Bearer-token text so rotating invalid tokens cannot manufacture unlimited limiter buckets.

## Production validation gate

The hardening PR is the authoritative integration gate. Repository PR CI must pass the production build,
Prisma migration deploy/drift checks, lint, typecheck, full tests, release smoke validation, DB-pool
budget self-test, and production Docker image build before this stack can be called production-ready.
Validation must run against the current PR head after every hardening fix; a green result for an older
commit is not sufficient.

The repository also contains `scripts/mcp-release-smoke.mjs` (`npm run smoke:mcp-release`) for the final
deployed-client check. Given a deployed `BASE_URL` and OAuth-issued `MCP_ACCESS_TOKEN`, it verifies MCP
metadata, authentication challenge behavior, server discovery, the required tool catalog, OAuth-bound
store context, snapshot privacy/lifecycle shape, recommendations, and private store resources.

The final validation rerun must use the exact current hardening head after all compiler and security fixes.
A green individual unit test or code inspection is not sufficient to override a failing stacked PR CI run.

Stack compatibility checkpoint: the hardening branch carries the current MCP root-discovery contract from its OAuth/server-tool bases so stacked PR mergeability and CI are validated against the same public surface.
