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

## 5. Meta connected-account fixture testing

Use a real Stride Meta OAuth connection and selected ad-account identity, but do not depend on that account having delivered ads.

1. Connect Meta through the normal Stride OAuth flow.
2. Verify accessible account discovery and select the intended test ad account.
3. Confirm the selected account exists locally as `MetaAdAccount` and has no provider-imported hierarchy you need to preserve.
4. Configure the local fixture target with the exact Stride store UUID and selected Meta account ID.
5. Preview the target with `npm run dev:meta-fixtures`.
6. Seed normalized hierarchy/mappings/60-day daily ad Insights with `npm run dev:meta-fixtures:write`.
7. Exercise Advertising, campaign/ad-set/ad/creative views, video retention, Product x Ads, mappings, currency isolation, Business Brief, data quality, confidence, and the deterministic Intelligence snapshot.
8. Confirm the fixture namespace is obvious (`stride_fixture_`) and no UI/report claims those rows prove live Meta fetching.
9. Remove only generated data with `npm run dev:meta-fixtures:cleanup` when finished.
10. Separately verify disconnect/reconnect, expired/revoked token behavior, account selection changes, and permission denial through the normal Meta OAuth connection.

The fixture writer never calls Meta write APIs and never modifies the real Meta connection/account identity. The only provider behavior not proven by this stage is reading hierarchy/Insights from the Meta API itself.

Before the first production merchant is considered fully validated, connect a consenting account with actual delivery history and run hierarchy + Insights sync. Compare a sample of campaigns, ads, spend, impressions, clicks, purchases, purchase value and attribution settings against Meta Ads Manager. That is the provider-fetch proof gate.

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
- connected-account Meta fixture flows succeed across analytics/intelligence/mapping surfaces
- real Meta hierarchy + Insights fetching is validated against at least one consenting merchant account with delivery history
- at least one source-resolution/mapping scenario is validated
- auth email retry succeeds after a simulated provider failure
- privacy webhooks are validated
- store isolation is validated
- no P0/P1 bugs remain
- benchmark has been captured and measured hotspots addressed
