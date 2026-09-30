# Shopify App Pricing launch configuration

Stride uses Shopify App Pricing for public App Store billing.

## Public plans

### Essentials — $49.99 USD / month

- 1 Shopify store
- 1 supported paid-media channel: Meta, TikTok, or Google Ads
- Shopify commerce/product/customer/inventory analytics
- campaign + supported creative intelligence
- Product × Ads and inventory-aware intelligence
- Stride Pixel, funnel analytics, and Session Explorer
- Shopify-backed server-side purchase conversions for the selected supported channel
- up to 10 current recommendations
- read-only MCP

### Pro — $84.99 USD / month

Everything in Essentials, plus:

- all supported paid-media channels
- cross-channel intelligence
- multi-session Visitor Journeys
- advanced Attribution Paths
- Shopify-backed server-side purchase conversions across configured supported channels
- up to 50 current recommendations

## Trial

Configure a 14-day Pro trial in Shopify App Pricing. Trial state is verified from Shopify's active subscription rather than created by Stride when Shopify App Pricing is enabled.

## Partner Dashboard setup

Create two public monthly plans in the Shopify Partner Dashboard and configure:

- exact price: `49.99 USD` for Essentials
- exact price: `84.99 USD` for Pro
- 14-day trial
- welcome link back into the embedded Stride app
- plan descriptions that match the entitlements above

Set production environment values:

```text
SHOPIFY_APP_PRICING_ENABLED=true
SHOPIFY_PARTNER_ORG_ID=...
SHOPIFY_PARTNER_API_ACCESS_TOKEN=...
SHOPIFY_PARTNER_APP_ID=gid://shopify/App/...
SHOPIFY_APP_HANDLE=stride
SHOPIFY_ESSENTIALS_PLAN_HANDLE=<exact Partner Dashboard handle>
SHOPIFY_PRO_PLAN_HANDLE=<exact Partner Dashboard handle>
```

## Runtime source of truth

- Shopify hosts plan selection, upgrade, downgrade, trial, proration, and billing UX.
- Stride does not call `appSubscriptionCreate` for public plans.
- Stride reads the Partner API Active Subscription and maps the configured plan handle to local entitlements.
- An unrecognized active plan fails closed.
- No active Shopify subscription means paid feature access is unavailable and the API returns the Shopify-hosted plan-selection URL.

## Test matrix before launch

1. New development-store install → Pro trial.
2. Trial → Essentials.
3. Trial → Pro.
4. Essentials → Pro upgrade.
5. Pro → Essentials downgrade.
6. Cancel at end of billing cycle.
7. Expired/cancelled subscription blocks paid routes.
8. Uninstall/reinstall does not create duplicate Store subscriptions.
9. Essentials enforces one ad provider.
10. Pro permits all supported ad providers and advanced attribution.
