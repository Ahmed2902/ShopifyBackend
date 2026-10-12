# Tracking validation before the Shopify demo

Do not mark a channel verified from an OAuth connection or an ad reporting sync.

## Deployment

Deploy the backend destination-test endpoint and the companion frontend. Owners/admins with an active plan can run three diagnostic requests per store per minute. Requests use the store's active destination and current provider authorization. No new environment variables or database migrations.

## Storefront capture

Open the real storefront and make an allowed, consented product-view/add-to-cart visit. In Integrations, use Check storefront tracking. The last received event time must match the visit. Check the session and the touched product for the same store and date range. Last N day presets include today in the store timezone.

## Meta and TikTok

Connect an accessible account, choose its website pixel/dataset, grant sharing permission and turn on sharing. Copy the test code from that destination's Test Events tab. Send the diagnostic using Metrico. Record the unique test event reference and find the same sample Purchase in the platform's Test Events view. An API acceptance alone is not independent evidence of processing. The test code is used only for this request and is not saved on the live destination. Synthetic diagnostics do not enter Metrico's order/session/delivery tables or purchase totals.

## Google

Choose an accessible client account and an eligible purchase conversion action, grant Data Manager permission and turn on sharing. Validate Google setup sends validateOnly=true, so Google validates the payload without uploading a conversion. This is not an end-to-end purchase delivery or attribution test. Warnings are surfaced. Real ingestion requires a separate real, eligible purchase and downstream diagnostics; a successful live request must retain its provider request ID. Google Ads test accounts do not support conversion uploads.

## Live purchase delivery

Use an eligible non-test, non-cancelled Shopify order with permitted matching evidence and consent. Shopify test orders remain excluded from live purchase forwarding. Verify the source order/event link, destination, worker delivery attempt, provider response and provider-side diagnostics. Keep identifiers consistent when testing browser/server deduplication. Do not create synthetic production purchases or bypass consent/billing to make a review video appear successful.

## Video sequence

1. Show connected channel and selected destination.
2. Show a real consented storefront visit and matching receipt time/session in Metrico.
3. Open the channel's Test Events view; copy its code for Meta/TikTok.
4. Run the Metrico diagnostic and show the matching sample in Test Events.
5. For Google, show validation-only success and explain that no conversion was uploaded.
6. Show live purchase delivery evidence only when actually observed. Otherwise explain the unverified portion explicitly.

Suggested caption: "This sample checks the sharing connection. Real purchase tracking also depends on storefront capture, consent and an eligible Shopify order."
