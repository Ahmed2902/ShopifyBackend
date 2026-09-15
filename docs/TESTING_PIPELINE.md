# Stride V1 Testing Pipeline

This document is mirrored by the backend testing-pipeline issue and is intended to be run only after the current backend/frontend main revisions and the persistent worker are deployed.

## 1. Environment readiness

- Deploy current backend main and apply all Prisma migrations.
- Run one persistent worker with `npm run start:worker` using the same database, Redis, Shopify, Meta, auth, and encryption environment variables as the API.
- Deploy current frontend main.
- Configure Resend for real auth-email testing.
- Set `LOG_REQUEST_PERFORMANCE=true` only during the benchmark pass.

## 2. Shopify development store

1. In Shopify Dev Dashboard, create or select a Dev store. Prefer generated test data if creating a new one.
2. Confirm the Stride app is the existing app used by the backend credentials.
3. From the Shopify CLI project, link the existing app configuration.
4. Generate/link the real Web Pixel extension and preserve Shopify's generated extension UID.
5. Confirm app scopes include at least the scopes currently required by Stride, including `write_pixels` and `read_customer_events`.
6. Confirm mandatory privacy webhooks point at `/v1/integrations/shopify/webhooks` for `customers/data_request`, `customers/redact`, and `shop/redact`, plus `app/uninstalled`.
7. Validate and deploy an unreleased app version first, inspect it, then release it.
8. Install/re-authorize Stride on the Dev store after any scope expansion.
9. In Shopify Admin > Settings > Customer events, verify the Stride app pixel is present.
10. In Stride, run Pixel install and inspect both Pixel status and Pixel health.

## 3. Shopify commerce test matrix

Prepare products covering:
- tracked inventory with stock
- tracked inventory at zero
- untracked inventory
- multiple variants
- collection membership
- product with cost evidence
- product without complete cost evidence

Exercise:
- initial catalog/inventory/order backfill
- product create/update/delete
- variant update/delete
- inventory level increase/decrease
- location changes
- order create
- refund (partial and full if practical)
- cancellation
- delayed webhook/reconciliation recovery
- app uninstall and reinstall
- privacy webhooks

For test orders use Shopify's supported Dev-store test-payment path such as Bogus Gateway/test mode; do not use real payments.

## 4. Stride Pixel storefront journey

Run a controlled storefront visit carrying deterministic Meta-like identity parameters where applicable:

landing/page view -> product view -> add to cart -> cart -> checkout -> checkout completed -> Shopify order ingestion -> pending order link -> exact order link -> behavior rollup -> attribution rollup -> Product x Ads evidence

Also test:
- analytics consent denied
- duplicate event IDs
- delayed/out-of-order events
- browser refresh and new session
- checkout/order arriving after Pixel events
- source-resolution changes
- stale Pixel installation/reinstall

Inspect:
- `/pixel/status`
- `/pixel/health`
- behavior overview/products/collections/landing pages
- sessions/journey explorer
- attribution sources/exact Meta ad/path evidence

## 5. Meta Marketing API sandbox/development testing

1. In Meta for Developers, open the existing Stride app and ensure Marketing API is configured.
2. Treat **app mode** and **Sandbox Ad Account** as separate safety controls. Use only the Sandbox Ad Account for this fixture. Meta currently rejects app-created ad creatives from a Development-mode app with code `100` / subcode `1885183`, so the app must be switched to **Live/Public** before Step 8 can create creatives/ads. The sandbox account still prevents these fixtures from becoming a real merchant delivery test.
3. Verify the app has the permissions/features required by the current Stride path. Read-only analytics requires `ads_read`; the optional tracking mutation path requires `ads_management` when enabled.
4. In Marketing API tools, create/select a Sandbox Ad Account if that option is available for the app.
5. Ensure the Facebook account/test user used for OAuth has access to the sandbox/test ad account.
6. Connect Meta through Stride OAuth and verify the returned account list is restricted to accessible accounts.
7. Select the sandbox/test account in Stride and run sync.
8. Run `npm run dev:meta-sandbox-seed:dry-run`, inspect the exact target, then run `npm run dev:meta-sandbox-seed:write`. Do not pass `--confirm-sandbox-write` through `npm run`; the dedicated write script avoids npm treating it as CLI configuration. Create enough campaign/ad-set/ad/creative hierarchy to validate entity sync, mapping, status, creative identity, selected-account scoping, and optional tracking-parameter mutation.
9. Verify disconnect/reconnect, expired/revoked token behavior, account selection changes, and permission denial.

Important: code `100` / subcode `1885183` is an app-mode gate. Changing the image URL/hash, Page ID, or creative payload does not fix that condition. Switch the Meta app to Live/Public, keep the confirmed target pointed at the Sandbox Ad Account, and rerun the idempotent seeder; already-created PAUSED hierarchy is reused.

Important: a Meta sandbox may not provide realistic delivered-ad insights/spend. If sandbox insights are empty, use it to validate auth/entity/mutation safety and later use a controlled real ad account with minimal spend for true insights/ROAS ingestion.

## 6. Cross-source truth validation

Confirm the UI/API never collapses these into one source:
- Shopify order/revenue/refund truth
- Meta provider-attributed purchases/value/ROAS
- Stride Pixel first-party observed journey/attribution
- Stride-derived Product x Ads/shared-exposure evidence

Check same-currency behavior, foreign Meta currency separation, mapping confidence, inventory trust mode, data-quality warnings, evidence quality, attribution precision, and limitations.

## 7. Auth and email E2E

Using real Resend delivery:
- register password account
- receive verification email
- verify once
- confirm second use fails
- resend verification cooldown
- unverified login rejection
- forgot-password generic response for real and fake addresses
- receive reset email
- expired/invalid token behavior
- reset password
- verify every previous refresh session is revoked
- verify Google-only account does not get password-reset mail
- stop or break Resend temporarily and verify durable auth-email retry recovers once delivery is restored

## 8. Frontend intensive pass

Test desktop + mobile, dark + light, loading/error/empty/partial states for:
- auth
- Overview
- Advertising
- Products/Collections/Inventory/Customers
- Campaigns/Ad sets/Ads/Creatives
- Integrations
- Data Quality
- Pixel behavior
- Sessions/Journeys
- Attribution
- Mapping Review / Ad Exposure

Switch Store A -> Store B repeatedly and verify no Store A data or local integration state flashes in Store B.

## 9. Performance benchmark

With a fresh access token and real Store ID:

```powershell
$env:BASE_URL="https://<backend>"
$env:STORE_ID="<store uuid>"
$env:ACCESS_TOKEN="<fresh access jwt>"
$env:BENCHMARK_ITERATIONS="20"
$env:BENCHMARK_WARMUPS="3"
npm run perf:analytics
```

Capture forced-refresh and warm-cache p50/p95, Prisma query count, DB wall time, slowest queries, and response bytes for Dashboard, Intelligence, Advertising, and TikTok monitor when configured.

Do not add indexes or rewrite queries until this evidence identifies a real hotspot.

## 10. Exit gate

Do not call V1 production-ready until:
- full Shopify journey succeeds
- delayed-order recovery succeeds
- Pixel health/backlogs recover to healthy
- Meta sandbox/dev auth/entity flow succeeds
- at least one source-resolution/mapping scenario is validated
- auth email retry succeeds after a simulated provider failure
- privacy webhooks are validated
- store isolation is validated
- no P0/P1 bugs remain
- benchmark has been captured and measured hotspots addressed
