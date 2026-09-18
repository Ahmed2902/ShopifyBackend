# Stride V1 release smoke

Use this after deploying the intended backend revision to a real Shopify development/test store. It turns the highest-value release checks into one repeatable command without changing provider state by default.

## What the command checks

The default run is read-only and verifies:

- API liveness and PostgreSQL-backed readiness;
- authenticated billing state and the billing portal contract;
- Stride Pixel installation/status and operational health endpoints;
- Meta connection/configuration state;
- fresh Analytics Dashboard composition;
- fresh 30-day Business Brief composition;
- fresh deterministic Intelligence snapshot, including recommendation/data-quality contracts;
- Product × Ads analytics and mapping coverage.

The command intentionally does **not** install/rotate a Pixel, select a billing plan, alter Meta assets, mutate ads, or fake provider evidence.

## Required environment

```powershell
$env:BASE_URL="https://<backend-host>"
$env:STORE_ID="<store-uuid>"
$env:ACCESS_TOKEN="<fresh-owner-or-admin-access-token>"
npm run smoke:v1-release
```

Never commit or paste the access token into tickets, logs, screenshots, or chat transcripts.

## Production-shaped expectations

Once the corresponding provider pieces are configured, turn on strict expectations so the smoke run fails instead of merely reporting state.

```powershell
$env:EXPECT_SHOPIFY_BILLING="true"
$env:EXPECT_PIXEL_ACTIVE="true"
$env:EXPECT_META_CONNECTED="true"
$env:EXPECT_MIN_MAPPING_COVERAGE="0.50"
npm run smoke:v1-release
```

`EXPECT_MIN_MAPPING_COVERAGE` accepts a decimal from `0` to `1`. Only set a minimum after the test store actually has usable real Meta ads and deterministic mapping evidence. Do not invent a passing threshold for an empty sandbox account.

## Optional live checks

### Re-verify Shopify billing

`POST /billing/refresh` synchronizes local subscription state from Shopify. It is not part of the read-only default because it mutates the locally cached billing record.

```powershell
$env:SMOKE_REFRESH_BILLING="true"
npm run smoke:v1-release
```

Use this only after Shopify App Pricing plans and handles are configured for the linked public app.

### Enqueue a real password-reset email

The smoke command can call the real forgot-password endpoint, but it cannot prove inbox delivery or click the link for you.

```powershell
$env:SMOKE_SEND_AUTH_EMAIL="true"
$env:AUTH_TEST_EMAIL="qa+stride@example.com"
npm run smoke:v1-release
```

After the request succeeds, manually verify all of the following:

1. the message arrives from the verified Stride sender;
2. the reset URL points to the expected frontend origin;
3. the token works exactly once;
4. the old password stops working and the new password works;
5. reusing the token fails;
6. the worker has no stuck/retrying email-delivery backlog.

Use only an address you control. The script masks the address in its summary.

## What still requires a human/provider round trip

A green smoke command is necessary release evidence, but it is not sufficient to claim provider validation is complete. Also execute:

### Shopify billing

- open the hosted pricing URL returned by `/billing/portal`;
- start/accept the intended test subscription;
- verify the local billing read becomes `provider=SHOPIFY`, `accessActive=true`, and the expected plan;
- exercise plan change/cancel behavior using the test store;
- verify an inactive subscription is denied by paid middleware.

### Stride Pixel and Shopify purchase truth

Perform a real storefront journey:

```text
page view
→ product view
→ add to cart
→ checkout
→ checkout completion
→ Shopify order ingestion/reconciliation
```

Confirm the session becomes linked to the real Shopify order. Checkout-complete browser evidence alone must never become commerce revenue truth.

### Product × Ads

Use an account with actual usable ads. Confirm:

- exact deterministic mappings appear when evidence supports them;
- shared/multi-product exposure stays shared and is not equally allocated;
- low mapping coverage is visible as data-quality evidence;
- mapping-dependent decisions remain suppressed or lower-confidence when evidence is insufficient.

Meta sandbox limitations are not a reason to manufacture mapping evidence.

## Interpreting failures

Treat these as release blockers until explained:

- `/health/ready` is not 2xx;
- billing access is unexpectedly inactive;
- strict Shopify billing expectation is enabled but provider verification is not Shopify-backed;
- strict Pixel expectation is enabled but installation is not `ACTIVE` or lacks a Shopify Web Pixel ID;
- fresh dashboard/report/intelligence reads fail;
- intelligence response lacks recommendation or data-quality contracts;
- a configured mapping minimum is not met;
- a provider-changing optional check fails midway.

A low/zero mapping coverage value is not itself a code failure when the test account has no usable ads; the test data must be capable of exercising the feature before enabling `EXPECT_MIN_MAPPING_COVERAGE`.

## CI safety

CI only executes:

```bash
npm run smoke:v1-release:check
```

That runs `node --check` against the script. CI never calls live provider endpoints or requires deployment secrets.
