# Stride — Shopify App Store reviewer instructions

> Replace every `<placeholder>` before submission. Do not submit this file with fake credentials or inaccessible resources.

## App

- App name: Stride
- App URL: `<https://...>`
- Support email: `<support@...>`
- Review contact: `<name + email>`

## Test store

- Development/review store: `<store.myshopify.com>`
- Shopify-provided reviewer access: `<describe exact access path>`
- Expected initial state: `<new install / seeded test data / existing connected data>`

## Installation and authentication

1. Install Stride from the Shopify review surface.
2. Approve the requested scopes.
3. Open Stride from **Shopify Admin → Apps → Stride**.
4. No separate Stride account, password, email verification, or Google sign-in is required.
5. The embedded app authenticates using Shopify App Bridge ID tokens.

Expected result: Stride opens directly into the merchant workspace for the installed shop.

## Billing

Stride uses Shopify App Pricing.

- Essentials: $49.99 USD/month
- Pro: $84.99 USD/month
- Trial: 14-day Pro trial

Review steps:

1. Open `<exact billing/settings path>`.
2. Select **Manage plan**.
3. Shopify opens the hosted pricing page.
4. Select Essentials or Pro.
5. Return to Stride and refresh billing state.

No external payment processor or card form is used by Stride.

## Shopify data setup

After install, Stride reads the shop's permitted Shopify data through the GraphQL Admin API.

To populate the review store:

1. `<create/import products>`
2. `<create orders or use provided seeded orders>`
3. `<ensure inventory exists>`
4. In Stride, open `<sync path>` and trigger/observe sync if needed.

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
- Connection path: `<path>`
- Expected data: `<campaign/ad/creative fixtures or live test account>`

### TikTok

- Account/test asset: `<details or N/A if not submitted as launch-ready>`

### Google Ads

- Account/test asset: `<details or N/A if not submitted as launch-ready>`

Do not list a provider as launch-ready in the App Store listing unless the reviewer can validate its connection and core data flow.

## Core Stride features to review

1. **Overview** — Shopify commerce truth beside supported paid-media evidence.
2. **Advertising** — provider/account/campaign/group/ad hierarchy and daily metrics.
3. **Product × Ads** — exact/shared/unmapped product-ad relationships; ambiguous spend is not silently allocated.
4. **Inventory-aware intelligence** — stock context shown beside paid activity where required evidence exists.
5. **Stride Pixel** — first-party storefront sessions/funnel behavior where the review store has events.
6. **Recommendations** — deterministic, read-only findings; Stride does not automatically change campaign budgets.
7. **Billing/entitlements** — Essentials one-channel limit and Pro advanced/multi-channel access.

## Protected customer data

Stride requests level-1 protected customer data because Order resources are required for analytics.

Current launch queries do not request customer name, email, phone, billing address, or shipping address.

Purpose: order/refund/line-item/value/timestamp and customer-journey aggregate facts are used for commerce, product profitability, attribution, and paid-growth analytics.

## Privacy requests

The app handles Shopify privacy topics:

- customers/data_request
- customers/redact
- shop/redact

Provide any additional reviewer steps here: `<steps or N/A>`.

## Uninstall / reinstall

1. Uninstall Stride from Shopify Admin.
2. Confirm access credentials are no longer treated as active.
3. Reinstall Stride.
4. Open the app again through Shopify Admin.

Expected result: the same Shopify shop is reconciled to its Stride tenant without duplicate store creation, and the new installation credentials become authoritative.

## Known review notes

- `<none, or list narrowly scoped limitations that are accurately represented in the listing>`
