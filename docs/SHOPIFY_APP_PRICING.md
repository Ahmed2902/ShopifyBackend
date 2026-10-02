# Shopify App Pricing launch contract

Stride uses **Shopify App Pricing** for public App Store billing. Do not add Stripe, Lemon Squeezy, `appSubscriptionCreate`, or a second recurring billing authority for the Shopify-distributed product.

## Launch plans

Ahmed confirmed these prices and 14 trial days on both plans on 2026-10-03 (Africa/Cairo). Source catalogs already match. Actual hosted plans remain an account task; use [account setup](SHOPIFY_APP_ACCOUNT_SETUP.md) for exact value/environment mappings. Shopify determines returning-store trial eligibility.

Configure these as public monthly plans in Shopify's Partner/Dev Dashboard:

| Plan | Price | Billing | Trial |
| --- | ---: | --- | --- |
| Essentials | **$49.99 USD** | every 30 days | **14 days** |
| Pro | **$84.99 USD** | every 30 days | **14 days** |

The 14-day trial is Pro-equivalent inside Stride: while Shopify reports an active trial, `effectivePlan=PRO` even if the merchant selected Essentials. When the trial ends, entitlements fall back to the selected Shopify plan.

## Essentials

One Shopify store and one supported paid-media provider at a time:

- Shopify commerce/product/customer aggregate/inventory analytics
- campaign + supported creative intelligence
- Product × Ads
- inventory-aware intelligence
- Stride Pixel + storefront funnels
- Session Explorer
- up to 10 current recommendations
- read-only MCP
- Shopify-backed server-side purchase conversions for the selected paid provider

Not included:

- multiple simultaneous paid providers
- cross-channel intelligence
- multi-session Visitor Journeys
- advanced Attribution Paths

## Pro

Everything in Essentials plus:

- all supported paid-media providers
- cross-channel intelligence
- multi-session Visitor Journeys
- advanced Attribution Paths
- up to 50 current recommendations
- server-side purchase conversions across all configured supported providers

## Dashboard configuration

1. Open the Stride public app in the Shopify Partner/Dev Dashboard.
2. Create/edit the public App Pricing plans.
3. Set Essentials to exactly **49.99 USD / EVERY_30_DAYS / 14-day trial**.
4. Set Pro to exactly **84.99 USD / EVERY_30_DAYS / 14-day trial**.
5. Record the exact plan/item handles.
6. Set production environment values:
   - `SHOPIFY_APP_PRICING_ENABLED=true`
   - `SHOPIFY_PARTNER_ORG_ID`
   - `SHOPIFY_PARTNER_API_ACCESS_TOKEN`
   - `SHOPIFY_PARTNER_APP_ID`
   - `SHOPIFY_APP_HANDLE`
   - `SHOPIFY_ESSENTIALS_PLAN_HANDLE`
   - `SHOPIFY_PRO_PLAN_HANDLE`
7. Keep `SHOPIFY_BILLING_VERIFY_TTL_SECONDS` at a reasonable short reconciliation interval (default 300 seconds).

The Partner API credential must be kept server-side and have the permissions needed to read the app's active subscriptions.

## Runtime behavior

- plan selection, upgrade, downgrade, payment and cancellation UI is Shopify-hosted;
- `GET /v1/stores/:storeId/billing/portal` returns the Shopify-hosted pricing URL;
- the old local `PATCH /plan` endpoint refuses direct plan mutation while App Pricing is enabled and returns the hosted plan URL;
- the backend periodically reconciles the active Shopify subscription and also supports an owner-triggered fresh read;
- if Shopify reports no active subscription, paid access fails closed;
- verified grants remain cached only within the verification TTL (default 300 seconds); once stale, every paid API/MCP/worker guard requires successful reconciliation and fails closed on an outage;
- the billing display may retain stale data with its stale indicator during a transient Partner API outage; displayed state never bypasses paid guards;
- uninstall immediately clears Shopify credentials, cancels cached entitlement, disables Pixel/conversion destinations and revokes MCP refresh grants;
- in-flight verification can grant access only to the same active installation generation; a reinstall invalidates the old billing verification;
- a zero-dollar priced contract is accepted only after the authenticated Admin API verifies that the same shop is a partner development store. Live stores still require the exact paid price.

## Configuration drift protection

Recognizing a plan handle is not enough. On fresh verification Stride also requires the Shopify subscription item to match the launch contract:

- `FlatRatePrice`
- active price
- USD
- `EVERY_30_DAYS`
- Essentials = `49.99`
- Pro = `84.99`

If the Partner Dashboard still contains the old `$49/$99` configuration (or a wrong currency/period), verification fails with `SHOPIFY_PLAN_CONFIGURATION_MISMATCH` rather than silently granting access against the wrong commercial contract.

The configured trial length cannot be proven from the active-subscription price item alone. The Partner Dashboard plan must therefore be manually checked for **14 days** before App Store submission, and the end-to-end test must exercise a real development/review installation.

## Required billing test matrix before submission

Use a development/review store and verify:

1. fresh install with no plan -> Shopify hosted pricing page;
2. start Essentials -> 14-day Pro-equivalent trial;
3. start Pro -> 14-day Pro-equivalent trial;
4. Essentials after trial -> one paid provider / 10 recommendations / no advanced journeys;
5. Pro after trial -> all providers / 50 recommendations / journeys + attribution;
6. Essentials -> Pro upgrade;
7. Pro -> Essentials downgrade, including channel-selection behavior if multiple providers are connected;
8. cancel at end of cycle;
9. canceled/expired subscription blocks paid routes and returns the Shopify plan URL;
10. uninstall/reinstall doesn't resurrect an old paid entitlement without fresh Shopify verification.

## Source of truth

- Shopify is the charging/subscription authority.
- `StoreSubscription` is a local reconciled cache used for authorization and resilience.
- `STRIDE_PLAN_CATALOG` is the application's expected commercial/entitlement contract.
- Public frontend pricing must match this contract exactly.
