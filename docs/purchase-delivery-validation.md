# Purchase delivery validation

Metrico detects purchases from synchronized Shopify orders. Browser events supply permission and matching evidence; Meta's `fbevents.js` is not required for the server adapter. A store-scoped digest of Shopify's canonical checkout token can correlate a permitted checkout with an order before a storefront session is materialized. An order, an email-marketing opt-in, or a browser-supplied order ID alone does not authorize advertising delivery.

## Deploy

1. Deploy the backend and apply the additive migration `20261012141000_purchase_delivery_checkout_proof` before deploying the frontend. Production startup already applies migrations.
2. Keep the Shopify connection on API version 2026-07 or newer for canonical checkout correlation. Older connections preserve their existing linked-session path. Shopify introduced `Order.checkoutToken` in 2026-07: https://shopify.dev/changelog/posts/new-checkouttoken-field-added-to-the-order-object.
3. No new environment variable or Shopify extension deployment is required. Existing customer enrichment still requires `SHOPIFY_ENHANCED_MATCHING_APPROVED`, the approved field list and the destination's enhanced-matching setting. Do not enable those settings without actual approval.

## Evidence without the Meta browser SDK

1. Use the deployed Metrico app on a Shopify development store and an enabled destination owned by an accessible account.
2. Use a dedicated test tracking source in the advertising platform. Keep unrelated live tracking apps disabled on this test store so their browser events cannot be mistaken for Metrico server receipts.
3. Accept advertising consent, view a product and add it to the cart. Confirm the storefront receipt timestamp advances in Metrico.
4. Repeat with only `connect.facebook.net/.../fbevents.js` blocked. Keep Metrico's collector available; blocking the collector is a separate scenario.
5. In the platform's Events Manager, identify the server event and its event ID. A browser event, SDK invocation or Metrico queued status alone does not establish server receipt.
6. Check Metrico's advanced matching coverage. For Meta/TikTok, observed public client IP plus observed browser user agent can supply matching context without `_fbp`/`_ttp`. The IP must resolve through the trusted ingress chain. When forwarding headers are present but the ingress is not trusted, Metrico omits IP rather than using a proxy's address.
7. Repeat after denying or withdrawing advertising consent. Advertising deliveries must be blocked, including queued retries.

## Complete checkout test

The synthetic sample button tests provider connectivity only. The development-store checkout test exercises the canonical order, retained permission record, queue, worker, matching and provider adapter.

1. Enable purchase sharing and copy a current Meta/TikTok Test Events code from the dedicated test destination. Google does not use a test code.
2. On the development storefront, accept advertising consent and complete a Shopify test-payment checkout. Do not manually create an order in Admin; that lacks the checkout permission observation.
3. Wait for the order to synchronize. In Metrico, open Integrations, select the channel, and expand **Test a complete checkout · Development stores**.
4. Click **Load test orders**, select the synchronized order, enter the test code above, and click **Run checkout test**.
5. The API verifies the development-store status from Shopify and requires an actual non-cancelled test order from this store. It requires a permitted checkout relationship. Codes are encrypted per delivery and expire after one hour. Repeated submission of the same order/destination is idempotent; use a new checkout for a new test.
6. Wait for the regular worker. For Meta/TikTok, the result must show channel acceptance, and the same Purchase must appear in the destination's Test Events screen. Expand the test reference to record the receipt ID.
7. Google always runs `validateOnly=true`. **Validation passed** means no conversion was uploaded. Warnings need review. Actual Google ingestion, identity matching and campaign attribution need separate evidence; do not represent validation as live delivery.
8. Test deliveries do not enter live delivery lists or tracking-health totals. Normal background purchase sweeps continue to exclude test orders.

## Live purchase reconciliation

Purchase health covers non-test, non-cancelled synchronized Shopify orders since the current installation, over the last 30 days. Accepted means at least one Metrico destination for that channel acknowledged the order. It does not prove all destinations received it or that the platform attributed it to an ad. Not queued includes absent consent, missing matching evidence, disabled setup, inactive entitlement and orders outside the seven-day send window.

Metrico retries transient provider failures with stable event IDs. Missing matching/context receives a bounded preparation window and then a clear failure if evidence remains unavailable. Previously dead historical events are not automatically resurrected. Changing or withdrawing consent, disabling a destination, uninstalling or changing the permitted plan is rechecked before send.

Neither webhook capture nor API receipt establishes 100% attribution or increased ROAS. We cannot recover unobserved browser interactions or send advertising events without usable permission.
