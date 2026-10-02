# Stride App Store code review — 2026-10-02

Scope: backend submission-readiness branch plus its frontend companion, based on the current merged main revisions. This is a code review and local verification, not Shopify approval or a deployed-runtime certification.

Sources: the canonical Shopify AI requirements document was fetched using Shopify CLI; also reviewed the [full App Store requirements](https://shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements), [Shopify App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing), Partner activeSubscription 2026-07 schema, Admin ShopPlan 2026-07 schema and Web Pixels Customer Privacy documentation. Each requirement below was evaluated separately. “Likely passing” describes inspected code; “Needs review” requires account, live-runtime or listing evidence.

## Core requirement results

| Requirement | Result | Evidence / remaining check |
| --- | --- | --- |
| 1.1.1 Session-token authentication | Needs review | Embedded ID tokens, token exchange and storage-blocked mocked browser test; verify real Chrome incognito inside Shopify. |
| 1.1.2 Shopify checkout | Likely passing | Analytics app; no offsite buyer checkout/order creation. |
| 1.1.3 Shopify Theme Store | Likely passing | No theme download/install feature. |
| 1.1.4 Factual information | Needs review | Preserve source-labelled calculated data; review final listing, screenshots and marketing claims against shipped features. |
| 1.1.6 Single-merchant storefronts | Likely passing | Tenant-scoped merchant analytics; no multi-seller marketplace. |
| 1.1.7 Authorized payment gateways | Likely passing | No payment gateway; app subscription payment is Shopify-hosted. |
| 1.1.8 No third-party POS | Likely passing | No external POS integration. |
| 1.1.9 Optional buyer charges | Likely passing | No cart fees or optional buyer charges. |
| 1.1.10 Cheapest shipping default | Likely passing | No delivery-option mutation. |
| 1.1.13 Authorized product duplication | Likely passing | Reads installed merchant catalog; no competitor copying feature. |
| 1.1.14 No agency marketplace | Likely passing | No external agency/developer marketplace. |
| 1.1.15 Original-processor refunds | Likely passing | Imports Shopify refund facts; no app-owned refund processor or wallet. |
| 1.1.16 No lending | Likely passing | No capital or lending function. |
| 1.2.1 Shopify app billing | Needs review | Production enforces App Pricing; configure real hosted plans, Partner credentials, matching listing prices and trial eligibility. |
| 1.2.2 Correct billing lifecycle | Needs review | Exact prices/handles/tenant, trusted development-store zero contracts, stale guard fail-closed, uninstall/reinstall invalidation covered; real accept/decline/reinstall still needed. |
| 1.2.3 Plan changes | Needs review | Owner/admin opens Shopify hosted pricing; verify live upgrade/downgrade/deferred-change behavior. |
| 2.2.1 Shopify APIs | Likely passing | Commerce uses Shopify GraphQL with tenant-specific credentials. |
| 2.2.3 Latest App Bridge | Needs review | Latest unversioned CDN configured with Next beforeInteractive and API-key meta; inspect final deployed document/script ordering and SDK initialization inside Shopify. Next streaming emits framework tags before its script queue; do not infer literal first-script compliance from mocked tests. |
| 2.2.4 GraphQL Admin | Likely passing | GraphQL Admin client; no core REST dependency. |
| 2.2.6 No admin-extension ads | Likely passing | No promotions/ad placements in admin extensions. |
| 2.2.7 Merchant-initiated Max modal | Likely passing | No Max modal calls. |
| 2.3.1 Shopify-owned installation | Needs review | Public install entry directs to Shopify listing; managed installation TOML generated. Configure actual listing/install surface. |
| 2.3.2 Immediate authentication | Needs review | ID-token bootstrap/token exchange; verify actual first install. |
| 2.3.3 App UI redirect | Needs review | App URL must target frontend /app; verify actual managed install redirect. |
| 2.3.4 Immediate reinstall OAuth | Needs review | Inactive connection gets new token exchange and billing verification reset; test real reinstall and delayed uninstall. |
| 3.1.1 Valid TLS | Needs review | HTTPS startup/config gates; verify deployed TLS certificate and all public links. |
| 3.2.1 read_all_orders justification | Needs review | Optional only for real full-history analytics; obtain Shopify approval and explain need, otherwise omit. |
| 3.2.2 write_payment_mandate | Likely passing | Not requested. |
| 3.2.3 write_checkout_extensions_apis | Likely passing | Not requested. |
| 3.2.4 read_advanced_dom_pixel_events | Likely passing | Not requested. |
| 3.2.5 read_checkout_extensions_chat | Likely passing | Not requested. |

Counts: **19 likely passing / 0 known failing / 12 needs review / 31 core requirements**. None of the needs-review items is certified complete by this PR.

## Conditional groups skipped

Groups **5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9 and 5.10** were checked for applicability and skipped: Stride does not implement those specialized app categories. The repository's extension is a Web Pixel; template purpose declarations and actual deployed extension UID/version still require verification.

## Additional full-requirements gates

The canonical AI checklist omits some listing/runtime-only rules. Mandatory HMAC compliance webhooks, protected customer data approval, monitored support/emergency contacts, reachable privacy policy, reviewer credentials/instructions and an English screencast remain required submission evidence. The local readiness script rejects placeholder contacts/hosts but cannot establish actual monitoring, legal accuracy, live link availability or Dashboard approval.

All commerce data is minimized; no order email/phone/name/address query is introduced. Advertising purchase disclosure now requires explicit Shopify marketing and sale-of-data permission as well as analytics permission. Historical rows remain unauthorized. Verify real storefront consent changes, updated Pixel deployment and provider erasure operations.

## Submission decision

**Hold submission until the needs-review gates have evidence.** Do not replace a real authenticated install/billing/storefront/MCP journey with mocked UI tests or `node --check` smoke syntax checks. Use the submission runbook and reviewer instructions for exact procedures.
