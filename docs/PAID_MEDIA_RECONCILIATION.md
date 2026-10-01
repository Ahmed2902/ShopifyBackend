# Paid-media reconciliation

Stride keeps Meta, TikTok and Google Ads data fresh with a deliberately low-resource reconciliation policy. This subsystem is independent from server-side conversion delivery: reconciliation reads provider data into Stride; CAPI/Events/Data Manager sends Shopify-backed conversions from Stride to providers.

## Production cadence

One `AdvertisingReconciliationState` row exists per Store/provider, not per campaign or ad account.

- Meta daily reconciliation: exact 24-hour recurrence after each successful run. `syncInsights()` owns the rolling Insights refresh and refreshes the selected hierarchy immediately before importing Insights. After the initial import, the normal refresh window is the configured rolling refresh window.
- TikTok daily reconciliation: exact 24-hour recurrence after each successful run. It refreshes hierarchy and the normal 35-day rolling Insights window.
- Google Ads daily reconciliation: exact 24-hour recurrence after each successful run. It uses the existing `INCREMENTAL` sync, which refreshes hierarchy and the 35-day rolling metric window.
- Meta/TikTok catalogs: exact 72-hour recurrence after each successful catalog run when catalogs are configured.
- Google `change_status` is not polled in V1.
- No Meta webhook is required for V1 correctness.

The first schedule for each Store/provider is deterministically offset by up to one hour (catalogs by up to two hours) using Store ID + provider. That initial phase spreading avoids a deployment/midnight thundering herd without stretching later daily intervals beyond 24 hours.

## Initial history versus reconciliation

Routine reconciliation does not repeatedly reread a full year of provider history. Meta's first Insights import can still use its configured initial lookback (currently up to 365 days) when no local Insights exist; later Meta refreshes use the configured rolling refresh window. Google's explicit `HISTORICAL` sync remains its bootstrap path and is not routed through the daily queue. TikTok keeps its existing provider-module import semantics.

After initial history exists, scheduled and manual reconciliation use bounded rolling refreshes so late provider attribution can be corrected without rereading the entire account history on every run.

## Worker budget

`src/workers.ts` checks the reconciliation queue once per minute. A poll is only an indexed PostgreSQL due-work query; it does not call an advertising API unless work is due.

Each pass claims at most two provider states with `FOR UPDATE SKIP LOCKED` and processes those two concurrently. Stale claims are recoverable after 60 minutes. This keeps provider/network concurrency bounded even when many stores become due close together.

Schedule discovery scans configured active provider connections at most once per ten minutes per worker process. A Store-specific status read only checks that Store's three provider connections rather than scanning all tenants.

## Manual sync

The normal provider sync buttons are asynchronous:

- `POST /v1/stores/:storeId/integrations/meta/sync`
- `POST /v1/stores/:storeId/integrations/tiktok/sync`
- `POST /v1/stores/:storeId/integrations/google-ads/sync` with the default/`INCREMENTAL` mode
- `POST /v1/stores/:storeId/advertising/reconciliation/:provider/sync`

They enqueue high-priority work and return without holding the HTTP request open for provider pagination. Repeated requests are deduplicated. If the provider is already running, the API reports `RUNNING`; if already queued, it reports `QUEUED`; successful starts have a five-minute cooldown.

Google `HISTORICAL` remains an explicit synchronous bootstrap operation because it is not the normal merchant refresh button path.

Status is available from:

```text
GET /v1/stores/:storeId/advertising/reconciliation
```

The response exposes scheduling/operational state such as last start/success, next daily/catalog runs, queued manual/urgent work, retry time, failure count and reauthorization suspension reason. It never exposes provider credentials.

## TikTok webhook coalescing

TikTok remains the only paid-media provider with an inbound webhook queue in this V1 architecture. Webhooks are verified, persisted and deduplicated as before, but they no longer call TikTok APIs immediately for every delivery.

Instead they mark the Store/provider dirty with a one-minute debounce:

- `REPORT_DATA_CHANGE` -> `INSIGHTS`
- catalog/product events -> `CATALOG`
- ad/ad-group review, creative-fatigue and account-change events -> `HIERARCHY`

Multiple events union their required work on the same reconciliation row. A burst of webhook deliveries therefore results in one bounded refresh rather than one provider sync per webhook. Urgent Insights-only reconciliation uses a two-day window; the independent daily reconciliation still supplies the rolling correctness safety net.

## Billing and connection gates

Before any provider API call, background reconciliation requires:

- an ACTIVE provider connection;
- at least one selected provider advertising account/customer;
- an active Stride subscription/trial;
- provider entitlement under the Store's Essentials/Pro plan.

An Essentials Store does not spend API/DB resources refreshing a second provider that is outside its selected channel. Inactive providers make no external calls.

`REAUTH_REQUIRED` or equivalent OAuth/token failures suspend that provider's schedule. Schedule discovery does not reactivate a suspended row merely because the connection still reads ACTIVE; it requires the provider connection to have been updated after suspension, which is the reconnect/reconfiguration signal.

## Failure policy

Transient failures use bounded backoff:

1. 15 minutes
2. 1 hour
3. 4 hours

Manual refresh requests and TikTok webhook dirtiness are retained during backoff but do not erase `retryAt` or bypass the provider retry budget. After those retries are exhausted, Stride stops immediate retries and schedules the next normal daily/catalog reconciliation.

## Cache correctness

Meta/TikTok provider syncs already finalize their `SyncRun` through `IntegrationService`, which advances Store-scoped analytics/dashboard/intelligence cache generations after provider writes. Google reconciliation explicitly advances the same Store generations after its canonical writes and deterministic Product x Ads mapping projection.

This is targeted to the affected Store. Stride never flushes global Redis state after reconciliation.

## Separation from CAPI

Paid-media reconciliation is provider -> Stride ingestion.

Server-side conversion delivery is Stride -> provider delivery.

They use separate tables, queues, retries and workers. Failure or backpressure in one system must not block the other.
