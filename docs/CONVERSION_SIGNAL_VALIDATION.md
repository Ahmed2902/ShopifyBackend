# Conversion signal validation and production activation

This extends backend PR #151 on the App Store readiness branch (#150, including managed Meta destination work from #148). No merge or deployment is performed by this implementation. The companion settings and diagnostics are in frontend PR #100 on its App Store readiness base (#99).

## What is implemented

- Meta and TikTok server payloads include exact catalog item identifiers, quantities, and available unit prices. A destination selects a catalog already synced into the same store and provider connection. The merchant verifies that this is the catalog associated with the pixel in the provider UI; Stride does not infer that association.
- Active merchant-confirmed mappings and exact `RETAILER_ID_SKU` mappings with confidence 1 are eligible. Multiple different retailer identifiers for a variant are ambiguous and omitted. Catalog selection, catalog ownership, variant ownership and provider connection are checked independently. There is no guessed `shopify_COUNTRY_product_variant` scheme, fallback internal ID or arbitrary SKU rewrite.
- Shopify orders supply Purchase line items. Browser-observed product/cart/checkout items supply funnel content. Browser prices never replace Shopify Purchase revenue. Missing prices, currencies, quantities and catalog identifiers are omitted. A partial or truncated catalog match does not claim a complete basket item count.
- Product preparation uses bounded batch reads: source orders, source events, and mappings for each relevant provider. Purchase reads at most 101 lines to detect a 100-item payload limit; truncation is recorded. Browser checkout baskets above 100 lines omit their item snapshot rather than silently sending an incomplete observed basket.
- Factual stage diagnostics expose collected, advertising-permitted, queued, matching-prepared, provider-acknowledged and browser-reported events. Unique-event funnel counts do not double-count multiple destinations. Delivery identifier coverage and catalog item coverage retain their own denominators.

## Controlled Meta browser/server pairing

Shopify app Web Pixels run in a strict worker sandbox. Loading `fbevents.js` in that worker is unsupported. `extensions/stride-browser-signals` is a separate theme app embed using Shopify's Customer Privacy API and the official Meta browser SDK.

1. The merchant enables Meta funnel sharing, confirms `STRIDE_EXCLUSIVE` tracking ownership, enables browser pairing and activates the deployed app embed in the live theme.
2. The embed advertises a short sessionStorage heartbeat only while analytics, marketing and sale/sharing permission are all allowed.
3. After durable collector acceptance, the Web Pixel bridges only PageView, product-view and cart-addition event IDs. A batch expires after 60 seconds. No email, phone, checkout token, customer ID, IP or user-agent is put in the bridge. The collector credential is already a public, installation-scoped ingress capability; it never grants access to customer data.
4. `POST /v1/pixel/events/browser` authenticates that capability, reads only recent accepted events for that store, and checks the active installation, exact Shopify installation generation, retained consent, withdrawal tombstones, latest visitor/session permission, destination policy, managed Meta account ownership/scopes/token expiry and billing.
5. Authorization is batched and repeated after asynchronous preparation. The receipt expires after five seconds. The embed repeats authorization after SDK loading and checks live Shopify permission and its consent revision immediately before each SDK invocation.
6. `fbq('trackSingle', pixelId, eventName, customData, {eventID})` uses the same store-scoped SHA-256 event key as durable server delivery. Separate actions retain separate Shopify event IDs; retries retain the same ID. Automatic event configuration is disabled before initialization. No advanced-matching form scraping is configured by Stride.
7. An actual SDK-created `_fbp`, when available, is encrypted into the accepted source event with at most its existing 48-hour browser-context retention. No identifier is fabricated. Cookies issued before a known withdrawal are not attached to a fresh event.
8. The browser invocation report records `browserDispatchedAt`; it is not a provider receipt. The server worker retains independent retries, consent and entitlement checks immediately before HTTP send. Browser preparation gives that worker a bounded 15-second opportunity to collect a real cookie, without postponing retries indefinitely.

The embed refuses an existing global Meta SDK rather than taking over another app's initialization or consent. It reports overlap, SDK load failure/timeout and private page context using allowlisted reason codes. It does not disable any other integration automatically. SDK unavailability does not disable independent server delivery.

The SDK sends actual browser URL/referrer context. Therefore the embed refuses private checkout/account/order/cart-token surfaces, URL fragments, credentials, email-like values, and unreviewed URL/referrer parameters before loading or calling it. Supported parameters are the existing attribution allowlist plus numeric `variant`. This conservative guard reduces browser coverage on some link-shim/referral URLs; sanitizing the collector's URL alone cannot sanitize the browser SDK's location.

The live URL and referrer are rechecked after each authorization response, after SDK loading, and before each dispatch. A storefront URL change during asynchronous work cannot authorize sending a newly private page context.

On withdrawal the embed revokes its own SDK consent, clears its bridge and expires its own Meta cookies. Browser pairing remains stopped for that page lifecycle after regrant, because Stride cannot prove the SDK discarded its internal identifier cache. A fresh page load is required to resume. The Web Pixel retains a minimal installation-scoped cookie issuance cutoff; pre-withdrawal `_fbp`/`_fbc` are excluded. `_ttp` has no trusted issuance timestamp, so it is excluded after a known withdrawal rather than treating it as freshly authorized. Fresh click evidence and canonical, newly permitted Purchase matching remain independent.

## Limits and decisions

- The theme embed pairs only Meta storefront PageView/ViewContent/AddToCart. It cannot execute in Shopify's checkout sandbox. InitiateCheckout and Shopify-truth Purchase remain server-side. There is no claimed browser/server Purchase deduplication.
- TikTok remains server-side in this extension. Google remains Purchase/conversion-action based through the existing Data Manager adapter. Google is not treated as a generic Meta-style event receiver.
- Shopify native integrations and unrelated apps use independent event IDs. Neither Stride's event key nor its ownership confirmation proves deduplication with them. Review overlap separately for Purchase and each funnel stage.
- Earlier customer enrichment is intentionally limited to available deterministic proof. A historical visitor/customer relationship is not sufficient to identify whoever is currently using a shared browser. This implementation does not fetch a previous shopper's PII for a new PageView. A future authenticated Shopify customer flow would need a server-verifiable current customer proof and its own consent/lifecycle tests.
- Cross-domain identity and attribution propagation are not added. First-party storage is origin scoped. Copying competitor scripts that propagate click identifiers to every outbound link would disclose identifiers to unrelated domains. A future extension requires verified merchant-owned domains and an explicit allowlist.
- Diagnostic coverage is factual availability/preparation, not provider customer-match success, Meta Event Match Quality, attributable orders or causal lift. Collected counts cannot measure traffic that consent or architecture prevented Stride from observing. A platform receipt does not prove optimisation, attribution or incremental orders.

## Privacy, retention and schema

The migration `20261004120000_conversion_content_and_browser_coverage` is additive: nullable observed item/currency fields on StorefrontEvent, and nullable content-coverage, browser invocation timestamp and browser reason fields on ConversionDelivery. Existing store relations, installation boundaries, uniqueness and deletion cascades remain authoritative. No new identity truth table is introduced.

Observed item snapshots use the raw event's existing bounded retention and deletion paths. Browser identifiers retain the earlier encrypted 48-hour class, with withdrawal/redaction/lifecycle handling. Customer matching continues to use canonical Shopify reads only where protected-data approval, field approvals, scopes and destination opt-in allow it; normalized customer hashes stay in worker memory. Browser receipts are no-store responses and bridges expire after one minute. The cookie cutoff is privacy-only state containing a timestamp, not a visitor identifier or a cookie history. Customer/shop redaction and uninstall continue to use the inherited purge and send-time checks.

Neither matching values nor provider payloads are logged. Diagnostics expose counts and reason codes, never emails, phones, cookie values, customer pseudonyms or access tokens.

## Production activation checklist

1. Ahmed reviews and manually merges the dependent backend/frontend PRs in their required order. Apply all migrations from the readiness base and the feature branch, then run drift validation against the actual production schema.
2. Deploy the Web Pixel update and CLI-generated theme extension under the same Shopify app. Keep the real Shopify-generated extension UIDs; the checked-in TOML files are templates. Validate the extension in a development store and activate the embed in the live theme through Shopify's theme editor. No technical IDs or secrets are entered by merchants in the new signals settings.
3. Complete Shopify protected customer data and field approvals before enabling the existing `SHOPIFY_ENHANCED_MATCHING_APPROVED`/field gates. Confirm App Store review covers the consented theme embed and provider data sharing. Configure privacy disclosures and Shopify privacy settings for advertising and sale/sharing purposes. Leave enhanced customer matching disabled until approval.
4. Use a real accessible Meta ad account/dataset, confirm `ads_management`, selected-account ownership and CAPI token health. Choose the actual connected catalog and confirm item IDs in Events Manager/catalog diagnostics. Disable provider automatic advanced matching and automatic event collection when validating Stride's explicit event path.
5. Audit native Meta/TikTok/Google integrations, other tracking apps and theme/GTM scripts. Establish one intentional owner for overlapping event paths. Do not claim unrelated apps share Stride event IDs. Confirm exclusive ownership only after this audit.
6. Meta Test Events: exercise one PageView, product view and cart addition with both paths; confirm identical event name/ID and actual deduplication in the provider. Verify genuine `_fbp`/`_fbc` when available. Exercise checkout and one canonical paid Shopify order; verify its single server Purchase, original event time, currency/value/order and supported permitted matching fields. Test retries with the same ID.
7. Test denied consent, analytics-only consent, consent withdrawal during SDK loading and worker preparation, later regrant/reload, uninstall/reinstall and customer/shop redaction against the deployed store. Verify no stale queued payload is sent. Verify overlap/ad-block/private-context reason codes without exposing sensitive values.
8. TikTok credentials alone are insufficient: use a real accessible advertiser, pixel/Events API destination, token and catalog; validate Purchase, ViewContent/AddToCart/InitiateCheckout names, identity fields, content IDs, receipt and retries in Events Manager. There is no new TikTok browser pairing claim.
9. Obtain Google OAuth credentials and appropriate Data Manager access, real selected customer/conversion action, required scopes, enhanced-conversion eligibility and consent configuration. Validate gclid/gbraid/wbraid placement, hashed identifiers and the resulting conversion action. Existing Google integration must pass live testing before activation.
10. Monitor initial stores for collection-to-queue gaps, prepared identifiers, unmapped/ambiguous items, delivery retries/dead letters and provider diagnostics. More complete signals may support optimisation; evaluate outcomes over an appropriate campaign window and use controlled experiments for claims of incremental orders.

## Provider authority

- Shopify Web Pixels: https://shopify.dev/docs/api/web-pixels-api
- Shopify Customer Privacy API: https://shopify.dev/docs/api/customer-privacy
- Theme app extension configuration: https://shopify.dev/docs/apps/build/online-store/theme-app-extensions/configuration
- Meta CAPI custom data: https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/custom-data
- Meta browser pixel and deduplication: https://developers.facebook.com/docs/meta-pixel/implementation/conversion-tracking and https://developers.facebook.com/docs/marketing-api/conversions-api/deduplicate-pixel-and-server-events
- Meta official server SDK models: https://github.com/facebook/facebook-nodejs-business-sdk/tree/main/src/objects/serverside
- TikTok parameters (updated March 2026): https://ads.tiktok.com/resources/help/article/about-parameters
- Existing identity/provider/Google requirements: see ENHANCED_CONVERSION_SIGNALS.md and its official documentation references.

Competitor public implementations were used to identify validation questions, not copied as authority or imported into Stride. Stride first-party attribution remains descriptive journey evidence; Shopify commerce truth and advertising-provider attribution remain distinct evidence families.
