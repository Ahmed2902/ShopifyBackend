# Shopify App Store submission runbook

This is the launch gate for Metrico as a public embedded Shopify app.

Commercial terms are confirmed: Essentials $49.99 / Pro $84.99 USD every 30 days and 14 trial days on both plans for eligible stores. Use [account setup](SHOPIFY_APP_ACCOUNT_SETUP.md), [the protected-data application draft](SHOPIFY_PROTECTED_DATA_APPLICATION.md), and the frontend listing package. Contacts/domain remain pending; account configuration and approvals have not been performed.

Run first:

```bash
npm run shopify:app-store:check
# Compare the exact environment settings used to build/deploy both services:
npm run release:check-config -- --backend-env /secure/backend.env --frontend-env /secure/frontend.env
```

The automated gate covers backend/config facts. Complete every manual item below before pressing **Submit for review**.

## 1. Distribution and embedded experience

- Distribution type is public / Shopify App Store.
- Metrico opens as an embedded app inside Shopify Admin.
- The frontend loads the current Shopify App Bridge before app scripts and uses Shopify ID-token authenticated requests.
- A merchant never has to create a Metrico password, sign in with Google, or type their `myshopify.com` domain to install the app.
- Install/open/reopen works from a Shopify-owned surface.
- Uninstall and reinstall produce a clean authenticated app session without duplicate Store rows.

Backend evidence: Phase 1 verifies Shopify ID tokens, exchanges them for Shopify access tokens, and maps `shop + staff user` into existing Metrico RBAC.

## 2. Shopify APIs

- GraphQL Admin API is used for Shopify data access.
- Required scopes are the minimum needed for visible Metrico functionality.
- `write_products` is requested only if collection-write functionality remains launch scope; otherwise remove it before submission.
- No legacy REST Admin API dependency is required for core functionality.

## 3. Protected customer data

Metrico reads Order resources, so request **level 1 protected customer data** in Partner Dashboard.

Baseline order analytics does not request level-2 direct identifiers:

- no customer name
- no customer email
- no phone
- no billing address
- no shipping address

The justification should state that Metrico needs order/refund/line-item/timestamp/value and customer-journey aggregate facts to provide commerce, product profitability, attribution, and paid-growth analytics.

Optional enhanced conversion matching now has a separate, disabled-by-default path. Before including it in submission scope, obtain the required field approvals and record the actual operator allowlist and reviewer-safe destination. Enable it only with `SHOPIFY_ENHANCED_MATCHING_APPROVED=true`, an enabled enhanced-matching destination and the existing buyer-permission/order-proof gates. The flag asserts actual approval; it cannot grant access. See `ENHANCED_CONVERSION_SIGNALS.md` and the protected-data application draft.

## 4. Privacy and compliance webhooks

Confirm the active app version subscribes to and successfully handles:

- `customers/data_request`
- `customers/redact`
- `shop/redact`
- app uninstall notification

Test each webhook against production-like infrastructure. HMAC verification, durable acknowledgement, redaction state, and uninstall credential invalidation must all work.

## 5. Shopify App Pricing

Configure public monthly plans in Partner Dashboard:

- Essentials — **$49.99 USD/month**
- Pro — **$84.99 USD/month**
- 14-day eligible trial on both plans, with Pro-equivalent Metrico access

Confirm:

- new install with no approved plan → hosted pricing; declined approval keeps billing/support usable
- approved plan → Shopify-confirmed trial when eligible
- plan selection is Shopify-hosted
- Essentials → Pro
- Pro → Essentials
- cancellation / end-of-cycle state
- expired subscription blocks paid routes
- reinstall does not create duplicate subscription state

The App Store listing, Shopify pricing page, Metrico public website, and backend catalog must show the same pricing and feature boundaries.

## 6. Listing requirements

Prepare real production assets/content:

- app name: Metrico
- subtitle and short description
- full description
- clear feature list
- supported languages
- pricing descriptions
- 1200 × 1200 app icon
- unique, current screenshots of the real product UI
- privacy policy URL
- terms URL
- support email
- support URL if used
- emergency developer contact in Partner Dashboard

Do not use mock screenshots, fake customer results, benchmark claims without data, or features that are not production-ready.

## 7. Reviewer screencast

Record an English screencast (or English subtitles) showing the full review path:

1. Install Metrico from Shopify.
2. Open the embedded app without a separate Metrico login.
3. Show Shopify sync / initial data state.
4. Show the Shopify-hosted plan selection / trial state.
5. Connect one supported advertising provider using the reviewer-safe test path.
6. Open Overview / commerce analytics.
7. Open Advertising hierarchy.
8. Open Product × Ads.
9. Show Metrico Pixel / storefront analytics where test data exists.
10. Show recommendations/read-only decision workflow.
11. Show billing upgrade/downgrade path.
12. Show disconnect/uninstall behavior where practical.

## 8. Reviewer access/instructions

Use `docs/SHOPIFY_REVIEWER_INSTRUCTIONS.template.md` and replace every placeholder with real review-safe values.

The reviewer must be able to reach meaningful functionality without contacting us for missing setup information.

## 9. Production links and contacts

Before submission set real values for:

- `SHOPIFY_APP_URL`
- `SHOPIFY_PRIVACY_POLICY_URL`
- `SHOPIFY_TERMS_URL`
- `SHOPIFY_SUPPORT_EMAIL`
- `SHOPIFY_REVIEW_CONTACT_EMAIL`
- `SHOPIFY_EMERGENCY_CONTACT_EMAIL`

These values must agree with Partner Dashboard and the public Metrico website.

## 10. Final technical gate

Run locally against the exact submission revision:

```bash
npm run prisma:validate
npm run lint
npm run typecheck
RUN_DB_TESTS=true npm run ci
npm run smoke:v1-release:check
npm run shopify:app-store:check
```

Then manually test the entire merchant journey in a development store using the same app configuration that will be submitted.

## Not required for initial listing

Built for Shopify is a later quality milestone, not a prerequisite for first App Store publication. Treat it as a post-launch goal after Metrico has real active installs and reviews.


## Deployment configuration and account gates

Run `npm run shopify:app-config` with real deployment environment values. It writes an ignored `shopify.app.toml` containing only public app identifiers/URLs, minimal scopes, managed installation, operational webhooks and all three compliance topics. Keep the actual Shopify-generated extension UID. Validate with `shopify app config validate --json` in the linked app project before deploying an app version. Configuration validation requires the real app/account context; renderer tests do not replace it.

Production now refuses to start with internal billing, missing App Pricing credentials/handles, legacy merchant authentication or non-HTTPS URLs. Set these before deploying this change. A 14-day Dashboard trial cannot be inferred from Partner API price data; manually check both plans and their eligibility rules.

The pixel extension declares analytics, marketing and sale-of-data purposes. New events explicitly record `adSharingAllowed` only when Shopify reports analytics, marketing and sale-of-data permission. Historical events default to false and are not retroactively authorized. Purchase delivery checks permission at enqueue and again immediately before sending; the latest retained event for the matching visitor/session must still permit sharing. Deploy the updated extension together with the backend migration. Analytics/advertising consent withdrawal and already-delivered provider data require real storefront verification and the documented provider deletion procedure.

For this PR, real TLS/link availability, Partner plan configuration, protected-data approval, linked Shopify CLI validation, published extension metadata, live install/reinstall/trial/upgrade/downgrade and authenticated V1/MCP runtime checks remain account/environment gates. Do not mark them passed based on mocked tests or script syntax checks. See `SHOPIFY_APP_STORE_REVIEW.md` for requirement-by-requirement findings.


## Reviewed concurrency and retry boundaries

Billing grants, absent-subscription results and invalid-contract revocations all compare the connection generation captured before the Partner request; a response from an old install cannot modify a newer verified reinstall. Scope webhook updates compare their delivery time against the installation inside the atomic database write.

Pixel retries rebuild their body from current buyer permissions. Withdrawal permanently downgrades or drops the in-flight batch, even if permission is later granted again. Duplicate collector retries can only downgrade an already retained event's advertising permission, without duplicating its analytics facts or reauthorizing historical permission. An outbound request already accepted by a collector/provider cannot be recalled; validate withdrawal timing and provider deletion in the real storefront journey.


## Fresh installation identity and durable withdrawal

Embedded bootstrap always exchanges current credentials and reads `currentAppInstallation.id`, even when the prior connection appears ACTIVE. A changed or unknown installation identity advances the generation, expires cached Shopify billing and disables prior Pixel/conversion destinations and MCP grants. The same installation preserves its generation. Older overlapping bootstrap responses cannot replace newer verification. Generation comparison ignores delayed old uninstall/scope notifications while still applying an actual current uninstall.

Migration 51 adds this installation identity/proof timestamp and tenant-scoped privacy-only revocation markers. Withdrawal sends a minimal visitor/session signal independently of analytics events; its durable collector acknowledgment makes it visible to provider delivery checks. Existing source permissions are downgraded, late batches consult the markers, and provider queries also consult the markers to cover overlapping ingestion. New post-regrant events cannot reauthorize an old purchase through a later click. The accepted ten-minute future-client-clock window is conservatively withheld after withdrawal; reporting continues, while fresh advertising permission applies only to new evidence beyond that cutoff. No historical permission is backfilled.

Deploy migrations 50 and 51 before the updated extension. On first verification of a previously untracked installation, re-enable the Pixel and any purchase destinations after billing verification; old OAuth/MCP grants remain revoked. Verify acknowledgment, reload/checkout-boundary withdrawal, network failure and already-delivered provider deletion in the real review store. A disconnected browser cannot guarantee immediate server acknowledgment of a revocation.
