# Shopify submission audit — October 7, 2026

**Not ready to submit until the live gates below are completed.** Source review found the necessary embedded authentication, hosted pricing, GraphQL and privacy foundations. This is a code review, not a Shopify certification or a Built for Shopify award.

Canonical requirements were fetched successfully using Shopify CLI on October 7:

```sh
npx --yes @shopify/cli@latest doc fetch --url https://shopify.dev/docs/apps/launch/app-store-review/app-store-ai-self-review-requirements --output /tmp/shopify-review.md
```

Two review passes: (1) inspect configured scopes, extension types, routes, API transports and billing integration; (2) trace install/session bootstrap, entitlement checks, uninstall/reinstall handling and the merchant-facing collection/onboarding screens against the selected criteria. Common groups 1.1, 1.2, 2.2, 2.3, 3.1 and 3.2 were reviewed. Group 5.1 is reviewed conservatively because a theme extension template is intended for deployment, although its actual Shopify-generated config is not committed yet.

## Source evidence by selected criterion

“Source supported” means the implementation supports the criterion; the deployed application can still fail it. “Live gate” needs operator evidence that code inspection cannot provide.

| Criterion | Finding          | Evidence / next action                                                                                                                                                                               |
| --------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1.1     | Source supported | Shopify ID-token verification, token exchange, tenant/staff membership in `src/modules/shopify/embedded/`; frontend App Bridge token attachment.                                                     |
| 1.1.2     | Source supported | Analytics app does not replace buyer checkout.                                                                                                                                                       |
| 1.1.3     | Source supported | No theme downloads or theme sales.                                                                                                                                                                   |
| 1.1.4     | Live gate        | Verify listing/screenshots match approved provider features; do not promise TikTok purchase sharing before approval or infer causal ROAS from first-party journeys.                                  |
| 1.1.6     | Source supported | No marketplace builder.                                                                                                                                                                              |
| 1.1.7     | Source supported | No payment gateway.                                                                                                                                                                                  |
| 1.1.8     | Source supported | No external POS integration.                                                                                                                                                                         |
| 1.1.9     | Source supported | No buyer cart charges.                                                                                                                                                                               |
| 1.1.10    | Source supported | No shipping selection changes.                                                                                                                                                                       |
| 1.1.13    | Source supported | Product data comes from the merchant-authorized shop.                                                                                                                                                |
| 1.1.14    | Source supported | No agency/developer referral marketplace.                                                                                                                                                            |
| 1.1.15    | Source supported | Reads refunds; does not issue refunds through another processor.                                                                                                                                     |
| 1.1.16    | Source supported | No lending.                                                                                                                                                                                          |
| 1.2.1     | Live gate        | Hosted Shopify App Pricing is implemented and required in production; configure real plans and Partner API access.                                                                                   |
| 1.2.2     | Live gate        | Test approval, decline, trial expiry, canceled subscription, reinstall and development-store behavior against actual Shopify billing.                                                                |
| 1.2.3     | Live gate        | Hosted upgrade/downgrade links implemented; verify both real configured plans.                                                                                                                       |
| 2.2.1     | Source supported | Shopify Admin API is used for authorized commerce data.                                                                                                                                              |
| 2.2.3     | Live gate        | Frontend Shopify document route loads the current CDN bridge before hydration. Verify deployed script ordering and merchant navigation inside Admin.                                                 |
| 2.2.4     | Source supported | Shopify transport uses versioned Admin GraphQL; no REST Admin transport found.                                                                                                                       |
| 2.2.6     | Source supported | No admin UI extension promotions.                                                                                                                                                                    |
| 2.2.7     | Source supported | No automatically launched Max modal.                                                                                                                                                                 |
| 2.3.1     | Live gate        | Production UI uses Shopify identity and no separate merchant signup. Install through a Shopify-owned surface and verify the published listing/install URL.                                           |
| 2.3.2     | Live gate        | Bootstrap exchanges verified session token and provisions identity; verify immediate post-install behavior.                                                                                          |
| 2.3.3     | Live gate        | Embedded /app UI and callback forwarding implemented; check actual production URL/Shopify config.                                                                                                    |
| 2.3.4     | Live gate        | Bootstrap remotely proves installation and refreshes credentials; verify uninstall/reinstall with delayed webhooks.                                                                                  |
| 3.1.1     | Live gate        | Requires deployed certificates for metrico.live, app.metrico.live and api.metrico.live.                                                                                                              |
| 3.2.1     | Live gate        | Historical order analysis and bulk backfill justify read_all_orders; enable the granted scope in the active version and reauthorize.                                                                 |
| 3.2.2     | Source supported | No write_payment_mandate scope or mandate writes.                                                                                                                                                    |
| 3.2.3     | Source supported | No write_checkout_extensions_apis scope or checkout extension writes.                                                                                                                                |
| 3.2.4     | Source supported | No read_advanced_dom_pixel_events scope; session evidence is event analysis, not DOM replay.                                                                                                         |
| 3.2.5     | Source supported | No read_checkout_extensions_chat scope or checkout chat.                                                                                                                                             |
| 5.1.1     | Source supported | Browser signals use a theme app embed; no Theme/Asset API writes, ScriptTags or merchant theme-code editing instructions.                                                                            |
| 5.1.3     | Source supported | Frontend Pixel panel includes activation instructions, Save step, live-theme deep link using the app API key, and link back to signal quality. Deploy the same-app extension with its generated UID. |
| 5.1.5     | Source supported | Merchant can view collected events, funnels, sessions and attribution inside the embedded app; privacy exports are surfaced.                                                                         |

Conditional groups 5.2, 5.4, 5.5, 5.6, 5.7 and 5.8 are skipped: no payment extension, selling-plan/subscription-contract feature, product-sourcing fulfillment feature, checkout customization, channel_config extension or post-purchase extension exists. Application subscription billing is not a buyer purchase-option app. Opt-in groups 5.3, 5.9 and 5.10 are skipped: no payment facilitator, mobile app builder or donation functionality was requested or implemented.

## Additional launch gates outside this source checklist

- Submit protected customer-data requests with the minimum necessary fields; Draft is not submitted. Keep `SHOPIFY_ENHANCED_MATCHING_APPROVED=false` until approved and verified. Approval to read all orders does not authorize every protected customer field.
- Run `npm run shopify:app-config` and `npm run shopify:app-store:check` using the actual production configuration. Resolve every failure; generated files must use your existing Metrico application and actual extension UIDs.
- Deploy the Web Pixel and theme extension under that same app. Use marketing/sale-of-data consent configuration appropriate to implemented purchase sharing; do not deploy the earlier analytics-only pixel configuration for advertising disclosure.
- Verify mandatory customer data-request, customer redaction, shop redaction and uninstall webhooks; verify exports, retention cleanup and deletion in the database. Mock tests do not prove Shopify delivery.
- Verify approved provider auth with real accounts, known reporting ranges, consent/no-consent purchases, queue retries, disconnect/revocation and destination ownership. Test browser/server deduplication only for features actually enabled.
- Test MCP consent/authorization and scoped reads from ChatGPT and Claude. A Connect button does not establish authorization by itself.
- Measure embedded performance using Shopify's real telemetry. Local builds/tests do not prove the 100+ call Core Web Vitals thresholds.
- Prepare monitored support/review/emergency contacts, listing assets, privacy/terms URLs and a concise reviewer path. Submit only verified feature claims. Built for Shopify performance/design highlights require a separate assessment.
