# Tracking production rollout

This implements the approved completed-checkout policy in `tracking-source-of-truth.md`. Ahmed merges manually. Merge backend PR #173 first, this backend change second, and the corresponding frontend change third. Deploy the backend migration and API/worker together before the frontend.

## Behavior

- A real online Shopify order with completed-checkout proof qualifies immediately, including COD and deferred payment. Payment and fulfillment states are separate facts. POS, draft/manual, B2B, test, zero-value, pre-installation, cancelled and unverified orders are excluded from live Purchase delivery.
- Shopify original shop-currency order value and processed time (created time fallback) supply immutable Purchase facts. Existing queued IDs, times, money and currencies are preserved. Historical baskets without a snapshot are omitted rather than reconstructed from edited lines. Newly considered pre-upgrade orders wait for canonical facts; bounded recent-order reconciliation promotes only this unsent exclusion after the facts become available. Edited orders first observed after the edit omit uncertain item details.
- Every connected, permitted destination with observed paid evidence receives the same logical purchase. Organic and unattributed orders are excluded. Internal reporting credit remains separate from platform attribution.
- Current Shopify order totals already reflect returns/refunds. Product and collection reporting reconcile removed units with line refunds once; cancellations are excluded. Estimates do not assert collected cash, delivery, fulfillment or guaranteed profit. Unrecorded returns cannot be inferred; no extra `read_returns` access is introduced by this change.
- Existing destinations without a delivery mode retain LIVE behavior. Newly configured destinations default to SHADOW. Explicit development-store checkout tests stay isolated and can run in preview mode; they are excluded from live health counts.
- SHADOW records eligible decisions without live provider calls or acknowledgement. Switching to LIVE requeues only recent shadow decisions, keeping IDs and facts, and the worker rechecks permissions. PAUSED stops pending live dispatch. Reactivation does not revive rejected, withdrawn, expired or terminal events automatically.

## Recovery and privacy

The theme embed can obtain a signed receipt referencing an existing retained consented paid-touch event, bound to its store, installation and canonical Shopify cart token. It stores only this opaque receipt in `_metrico_touch`; Shopify reconciliation verifies it against the actual order cart token. A browser-supplied order ID does not authorize purchase creation or customer-data access. Buy-now flows can skip the cart backup.

Shopify first/last journey visits are sanitized and used only with a verified retained consent relationship. Their use is bounded by the current installation, purchase lookback, withdrawals and a 30-day evidence expiry; cleanup clears the receipt relationship and visit data. Optional visit-field errors fall back to the core order query. A bounded recent cohort retries journey readiness independently of Shopify order update timestamps.

Every send rechecks current ownership, consent, uninstall/generation, billing, connection and protected-data settings. Matching identifiers are rebuilt, not frozen in the retry snapshot. Consent withdrawal or redaction can prevent a retry even after an ambiguous timeout. No IP/UA identity stitching, fingerprinting or fabricated click identifiers are introduced.

## Deployment and controls

1. Apply `20261014130000_conversion_purchase_facts` through the normal migration-first deployment. It adds immutable facts, recovery/evidence fields and backend-only dispatch-budget/circuit tables with RLS and browser grants revoked.
2. Deploy API and worker from the same backend revision. `CONVERSION_DELIVERY_ENABLED` defaults to true; false stops live worker dispatch and Meta browser authorizations deployment-wide. Restart API and worker after changing it. Collection and reporting continue.
3. Republish both `extensions/stride-pixel/src/index.js` and `extensions/stride-browser-signals/assets/browser-signals.js` through the existing Shopify extension projects, preserving each existing extension UID. Do not create duplicate pixels/embeds. Keep the embed enabled on the test store.
4. Deploy the companion frontend. Owners/admins see LIVE/SHADOW/PAUSED controls and delivery health; members have read-only mode visibility.
5. Review other Shopify/ad-channel trackers and set ownership explicitly. Independent integrations using different IDs can still double-count.
6. Start a new destination in SHADOW and inspect routing/exclusion decisions, then enable LIVE only for the intended merchant. Existing live destinations are not silently paused during upgrade.

## Validation and recording

- CI must pass on the exact backend/frontend heads, including migrated PostgreSQL race/privacy tests and container startup. Unit tests alone do not demonstrate platform deduplication or customer match.
- Complete a development-store COD checkout after a permitted TikTok or Meta paid landing. Verify an order exists while payment can remain pending, the queued event time is order time, its ID/facts are stable, and an explicit provider test receives an API acknowledgement.
- Repeat webhook/reconciliation and simulate an ambiguous provider timeout: there must be one logical ledger entry per order/destination/event name and a retry with the same ID/facts. A second outbound request can be legitimate after ambiguous acceptance.
- Test a direct/organic checkout, denied consent, withdrawal before retry, different cart/store receipt, uninstall/reinstall generation and cancellation before dispatch: no eligible live send should occur.
- Record a partial return/removal, then its corresponding refund: order/product/collection values must not subtract the same adjustment twice. Confirm the originally sent Purchase facts stay unchanged. Refunds do not automatically retract conversions in external ad dashboards.
- Exercise browser blocking without disabling the blocker. Shopify order reconciliation remains server-side; the browser breadcrumbs may be unavailable. Do not claim universal recovery when consent, checkout proof or paid evidence is absent.
- Check `GET /v1/stores/:storeId/conversion-delivery/delivery-health` through the app's authenticated owner/admin flow. Counts describe recorded eligible deliveries and API acceptance, not platform matching or attribution. Queue-age, credential and failure alerts appear here and emit safe operational warnings.
- Provider retries honor Retry-After, use jitter and stop at conservative provider-specific Metrico deadlines. Concurrent workers share a per-merchant/provider dispatch budget and provider outage circuit. The IDs never change to bypass a provider's retention window.

## External launch checks

Shopify protected customer data approval and TikTok automatic-ad-edit permission remain external gates. These changes do not grant either permission. Test-code acceptance, repeated Test Events rows and a fake provider cannot prove real ad attribution or conversion deduplication. Real-account validation, a controlled paid click and a consenting real customer purchase are still required for those claims. No Google live-delivery readiness claim is made.

MCP refresh/reconnect behavior is a separate integration concern. This implementation makes order reconciliation and retry delivery durable across process interruptions; it does not guarantee an MCP connection cannot disconnect. Check MCP health separately before recording.

## Rollback

Set `CONVERSION_DELIVERY_ENABLED=false` on both API and worker to stop outbound sending while investigating. Prefer this control or a forward fix over removing the additive migration. Never replay acknowledged orders under new IDs. Disabling an embed does not stop server delivery; pausing a destination does not remove events already accepted by a platform.
