# Shopify App Store submission runbook

This is the launch gate for Stride as a public embedded Shopify app.

Run first:

```bash
npm run shopify:app-store:check
```

The automated gate covers backend/config facts. Complete every manual item below before pressing **Submit for review**.

## 1. Distribution and embedded experience

- Distribution type is public / Shopify App Store.
- Stride opens as an embedded app inside Shopify Admin.
- The frontend loads the current Shopify App Bridge before app scripts and uses Shopify ID-token authenticated requests.
- A merchant never has to create a Stride password, sign in with Google, or type their `myshopify.com` domain to install the app.
- Install/open/reopen works from a Shopify-owned surface.
- Uninstall and reinstall produce a clean authenticated app session without duplicate Store rows.

Backend evidence: Phase 1 verifies Shopify ID tokens, exchanges them for Shopify access tokens, and maps `shop + staff user` into existing Stride RBAC.

## 2. Shopify APIs

- GraphQL Admin API is used for Shopify data access.
- Required scopes are the minimum needed for visible Stride functionality.
- `write_products` is requested only if collection-write functionality remains launch scope; otherwise remove it before submission.
- No legacy REST Admin API dependency is required for core functionality.

## 3. Protected customer data

Stride reads Order resources, so request **level 1 protected customer data** in Partner Dashboard.

Current order analytics intentionally do not request level-2 direct identifiers:

- no customer name
- no customer email
- no phone
- no billing address
- no shipping address

The justification should state that Stride needs order/refund/line-item/timestamp/value and customer-journey aggregate facts to provide commerce, product profitability, attribution, and paid-growth analytics.

Do **not** request level-2 fields unless the product later introduces a feature that genuinely needs them.

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
- 14-day Pro trial

Confirm:

- new install → trial
- plan selection is Shopify-hosted
- Essentials → Pro
- Pro → Essentials
- cancellation / end-of-cycle state
- expired subscription blocks paid routes
- reinstall does not create duplicate subscription state

The App Store listing, Shopify pricing page, Stride public website, and backend catalog must show the same pricing and feature boundaries.

## 6. Listing requirements

Prepare real production assets/content:

- app name: Stride
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

1. Install Stride from Shopify.
2. Open the embedded app without a separate Stride login.
3. Show Shopify sync / initial data state.
4. Show the Shopify-hosted plan selection / trial state.
5. Connect one supported advertising provider using the reviewer-safe test path.
6. Open Overview / commerce analytics.
7. Open Advertising hierarchy.
8. Open Product × Ads.
9. Show Stride Pixel / storefront analytics where test data exists.
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

These values must agree with Partner Dashboard and the public Stride website.

## 10. Final technical gate

Run locally against the exact submission revision:

```bash
npm run prisma:validate
npm run lint
npm run typecheck
npm test
npm run smoke:v1-release:check
npm run shopify:app-store:check
```

Then manually test the entire merchant journey in a development store using the same app configuration that will be submitted.

## Not required for initial listing

Built for Shopify is a later quality milestone, not a prerequisite for first App Store publication. Treat it as a post-launch goal after Stride has real active installs and reviews.
