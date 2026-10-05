# Metrico — Shopify App Store reviewer instructions

> Replace every `<placeholder>` before submission. Do not submit this file with fake credentials or inaccessible resources.

## App

- App name: Metrico
- App URL: `<https://...>`
- Support email: `<support@...>`
- Review contact: `<name + email>`

## Test store

- Development/review store: `<store.myshopify.com>`
- Shopify-provided reviewer access: `<describe exact access path>`
- Expected initial state: `<new install / seeded test data / existing connected data>`

## Installation and authentication

1. Install Metrico from the Shopify review surface.
2. Approve the requested scopes.
3. Open Metrico from **Shopify Admin → Apps → Metrico**.
4. No separate Metrico account, password, email verification, or Google sign-in is required.
5. The embedded app authenticates using Shopify App Bridge ID tokens.

Expected result: Metrico authenticates the installed shop. With no approved subscription, Plan & billing remains usable and paid screens request Shopify-hosted plan selection.

## Billing

Metrico uses Shopify App Pricing.

- Essentials: $49.99 USD every 30 days
- Pro: $84.99 USD every 30 days
- Trial: 14 days on both plans for eligible stores, with Pro-equivalent Metrico access while Shopify reports the trial active. Shopify determines remaining trial eligibility after reinstall.

Review steps:

1. Open **Plan & billing** at `/app/billing`.
2. Select **Manage plan**.
3. Shopify opens the hosted pricing page.
4. Select Essentials or Pro.
5. Return to Metrico and refresh billing state.

No external payment processor or card form is used by Metrico.

## Shopify data setup

After install, Metrico reads the shop's permitted Shopify data through the GraphQL Admin API.

To populate the review store:

1. In the disposable Shopify review store, create demo products/variants and a collection in Shopify Admin.
2. Create Shopify test orders for those products, including a refund if available. Do not place real paid orders.
3. Set inventory for the demo products at a review-store location.
4. Open **Connections** at `/app/integrations` and observe Shopify synchronization. Open Commerce → Products, Orders and Inventory to inspect imported records.

Expected surfaces:

- commerce summary
- products
- inventory
- orders
- product economics/analytics where sufficient data exists

## Advertising provider review path

Use one reviewer-safe provider path:

### Meta

- Account/test asset: `<details>`
- Connection path: **Connections** at `/app/integrations`; authorize Meta, select the review ad account and observe synchronization.
- Expected data: `<campaign/ad/creative fixtures or live test account>`

### TikTok

- Account/test asset: `<details or N/A if not submitted as launch-ready>`

### Google Ads

- Account/test asset: `<details or N/A if not submitted as launch-ready>`

Do not list a provider as launch-ready in the App Store listing unless the reviewer can validate its connection and core data flow.

## Core Metrico features to review

1. **Overview** — Shopify commerce truth beside supported paid-media evidence.
2. **Advertising** — provider/account/campaign/group/ad hierarchy and daily metrics.
3. **Product × Ads** — exact/shared/unmapped product-ad relationships; ambiguous spend is not silently allocated.
4. **Inventory-aware intelligence** — stock context shown beside paid activity where required evidence exists.
5. **Metrico Pixel** — first-party storefront sessions/funnel behavior where the review store has events.
6. **Recommendations** — deterministic, read-only findings; Metrico does not automatically change campaign budgets.
7. **Billing/entitlements** — `/app/billing`: Essentials one-channel limit and Pro advanced/multi-channel access.
8. **Merchant collection actions** — `/app/collections`: an owner/admin can explicitly create a collection and add selected products. This is why `write_products` is requested; recommendations do not perform these writes automatically.

## Protected customer data

Metrico requests level-1 protected customer data because Order resources are required for analytics.

Baseline commerce queries do not request customer name, email, phone, billing address or shipping address. Optional enhanced conversion matching is disabled by default. If it is included in the submitted review scope, document the actual approved fields and reviewer-safe destination below; the operator approval flag is not a Shopify permission grant.

- Enhanced matching review scope: `<disabled / actual approved fields and safe review path>`
- Approved matching allowlist: `<actual fields, or none>`

Test baseline purchase sharing with enhanced matching off first. For an approved enhanced-matching path, verify buyer consent, verified-order linkage, field omissions when evidence is absent, withdrawal and the complete customer export/redaction flow. Do not enable it with unapproved fields.

Purpose: order/refund/line-item/value/timestamp and customer-journey aggregate facts are used for commerce, product profitability, attribution, and paid-growth analytics.

## Privacy requests

The app handles Shopify privacy topics:

- customers/data_request
- customers/redact
- shop/redact

The Connections page at `/app/integrations` includes the Shopify privacy request panel. After a signed `customers/data_request` delivery is processed, OWNER/ADMIN can inspect the completed export; MEMBER cannot. The operator must validate all three topics on a disposable store before submission, including deletion after uninstall. See `SHOPIFY_PRIVACY_COMPLIANCE.md` for the precise steps.

## Uninstall / reinstall

1. Uninstall Metrico from Shopify Admin.
2. Confirm access credentials are no longer treated as active.
3. Reinstall Metrico.
4. Open the app again through Shopify Admin.

Expected result: the same shop reconciles to its tenant without duplication. Bootstrap verifies current credentials and Shopify AppInstallation identity even if the old uninstall webhook is delayed. Cached old billing cannot grant access to a changed installation. Reconfirm the hosted plan and reinstall the Pixel/re-enable destinations when applicable. A same-installation reopen preserves its generation; an old delayed uninstall cannot revoke a newer installation.

## Known review notes

- Recommendations are calculated and read-only; no automatic campaign-budget changes or guaranteed outcomes are claimed.
- Source-specific commerce, provider reporting and observed Pixel attribution remain distinct. Missing totals are not fabricated.
- Complete the real provider account/test-asset entries above and public contact/link entries before submitting. If a provider cannot be reviewed, do not advertise it as launch-ready.
- The English screencast and actual screenshot capture plan are in the frontend `docs/SHOPIFY_APP_STORE_LISTING.md`.
- Hosted plan/account configuration: `SHOPIFY_APP_ACCOUNT_SETUP.md`; prepared order-data request: `SHOPIFY_PROTECTED_DATA_APPLICATION.md`.
