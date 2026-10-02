# Stride — Shopify account setup

Commercial terms confirmed by Ahmed on 2026-10-03 (Africa/Cairo): Essentials **$49.99 USD every 30 days**, Pro **$84.99 USD every 30 days**, **14 trial days on both plans for eligible stores**. An active Shopify-confirmed trial gets Pro-equivalent Stride features. Shopify determines returning-store eligibility; uninstalling does not promise a fresh trial.

This document separates prepared application configuration from values that exist only in the actual Shopify account. No plans, credentials, approvals or charges were created by writing it.

## App identity

Use the existing Stride public app. Its client ID is safe for the frontend; its client secret is backend-only. In **Dev Dashboard → Apps → Stride → Settings → Credentials**, configure:

| Actual account value | Backend | Frontend |
| --- | --- | --- |
| Client ID | `SHOPIFY_CLIENT_ID` | `NEXT_PUBLIC_SHOPIFY_API_KEY` |
| Client secret | `SHOPIFY_CLIENT_SECRET` | Never expose |

Do not create a custom-store app as a substitute for the public Stride app. Keep merchant authentication in Shopify Admin; Google Ads OAuth remains an advertising connection.

## Hosted plans

Pricing and the App Store listing are in the **Partner Dashboard**, even if app settings have moved to the Dev Dashboard. Open **App distribution → All apps → Stride → Distribution → Manage listing → English → Pricing content → Manage**. Use Shopify App Pricing with monthly billing.

| Setting | Essentials | Pro |
| --- | --- | --- |
| Public plan name | Essentials | Pro |
| Recurring currency/price | USD / 49.99 | USD / 84.99 |
| Billing period | Every 30 days | Every 30 days |
| Free trial duration | 14 days | 14 days |
| Welcome path within Stride's `/app` root | `/billing` | `/billing` |
| Active advertising providers | One selected provider | All supported configured providers |
| Current recommendation limit | 10 | 50 |

Both plans include Shopify analytics, Product × Ads, inventory intelligence, storefront funnels, Session Explorer, read-only MCP and server-side purchase conversions within their channel allowance. Pro adds cross-channel intelligence, Visitor Journeys and advanced attribution.

Copy the actual subscription-item handles into `SHOPIFY_ESSENTIALS_PLAN_HANDLE` and `SHOPIFY_PRO_PLAN_HANDLE`; do not infer handles from the display names. Set `SHOPIFY_APP_HANDLE` from the actual hosted pricing URL. Confirm the resolved welcome destination is `/app/billing` in the linked installation. Keep pricing in the listing's designated pricing fields.

The backend rejects mismatched currency, billing interval, amount or handles. This does not create the Shopify plans or prove their Dashboard trial configuration.

## Partner subscription verification

An organization owner creates the Partner API client through **Partner Dashboard → Settings → Partner API clients → Manage Partner API clients**. Grant **Manage apps** for subscription reads; no financial-write permission is needed for Stride's read-only reconciliation.

Configure these backend-only deployment values:

- `SHOPIFY_APP_PRICING_ENABLED=true`
- `SHOPIFY_PARTNER_ORG_ID`: the organization owning this app.
- `SHOPIFY_PARTNER_API_ACCESS_TOKEN`: its Partner API client's secret access token.
- `SHOPIFY_PARTNER_APP_ID`: the actual `gid://shopify/App/...` identifier, not the client ID or an installation ID.
- `SHOPIFY_PARTNER_API_VERSION=2026-07`
- `SHOPIFY_BILLING_VERIFY_TTL_SECONDS=300`
- `LEGACY_MERCHANT_AUTH_ENABLED=false`

Put secrets directly in the deployment secret manager. Do not send tokens in review instructions, Git commits, screenshots or chat. These account values can be set before purchasing the final domain.

## Domain-dependent URLs and contacts

Once the domain is available, use the same reachable release origins throughout the following settings:

| Purpose | Configuration |
| --- | --- |
| Backend HTTPS origin | `APP_URL`; frontend `NEXT_PUBLIC_API_URL` |
| Frontend HTTPS origin | `FRONTEND_URL`, `CORS_ORIGIN`; frontend `NEXT_PUBLIC_SITE_URL` |
| Embedded application | `SHOPIFY_APP_URL` = frontend origin + `/app` |
| Frontend OAuth callback | `SHOPIFY_REDIRECT_URI` = frontend origin + `/api/shopify/callback` |
| Pixel collector | `PIXEL_COLLECTOR_URL` = backend origin + `/v1/pixel/events` |
| Mandatory webhooks | Backend origin + `/v1/integrations/shopify/webhooks` |
| Privacy and terms | `SHOPIFY_PRIVACY_POLICY_URL` = `/privacy`; `SHOPIFY_TERMS_URL` = `/terms` on the frontend origin |
| Support | `SHOPIFY_SUPPORT_EMAIL`; frontend `NEXT_PUBLIC_SUPPORT_EMAIL` |
| Reviewer and emergency mailboxes | `SHOPIFY_REVIEW_CONTACT_EMAIL`, `SHOPIFY_EMERGENCY_CONTACT_EMAIL` |

Contacts are intentionally pending Ahmed's domain. No mailbox is invented. `NEXT_PUBLIC_SITE_URL` must identify the exact deployment and be reachable by its server; this matters for App Bridge document delivery. Preview deployments need their own origin. Fill the actual listing URL only after Shopify supplies it.

## Data access and app release

Use [the prepared protected-data application](SHOPIFY_PROTECTED_DATA_APPLICATION.md) to request level-1 access for Order resources. Request `read_all_orders` only if historical access beyond Shopify's standard order window is enabled and approved. Keep `write_products` only for the visible owner-managed collection feature; describe it to the reviewer.

Then run `npm run shopify:app-config`, validate the linked configuration with `shopify app config validate --json`, and deploy the app version and updated Pixel using its real extension UID. Deploy migrations 50 and 51 with the backend before enabling that extension. The first verified bootstrap of a previously untracked installation invalidates cached billing and disables old Pixel/conversion destinations and MCP grants; reconnect those features after verification.

Account setup is complete only after a linked development store opens inside Shopify, verifies the actual installation ID, approves/declines hosted plans, exercises trial eligibility and plan changes, and receives all compliance topics. Record results in the submission runbook.

Sources: [App Pricing](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing), [trials](https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing/subscription-billing/offer-free-trials), [credentials](https://shopify.dev/docs/apps/build/authentication-authorization/manage-credentials), [Partner API](https://shopify.dev/docs/api/partner/2026-07).
