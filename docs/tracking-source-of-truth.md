# Metrico tracking source of truth

Approved product policy, version 1 — 14 October 2026.

Metrico tracking and reporting source of truth

Version 1.0 | 14 October 2026 | Owner Ahmed Abdelrahman

This document governs Metrico purchase tracking, evidence collection, platform delivery and reporting. It records the agreed product rules and the work needed to harden the current implementation. Requirements are the target behavior; they do not imply that every feature is already implemented or production-validated.

## Authority and scope

The approved decisions below supersede the earlier paid-only and delivered-only COD proposals and the conflicting requirements in Claude's original specification. Later owner decisions must update this document and its version. Ahmed merges PRs manually. This document authorizes no merge or production deployment by itself.

## Approved purchase rule

A completed checkout that produces a real Shopify order counts immediately as a purchase, including cash on delivery and other deferred-payment checkouts. Do not wait for delivery or a merchant marking payment received. Browser activity alone cannot create canonical purchase value: verify the Shopify order and its checkout relationship.

- Do not require financial status PAID for an otherwise eligible completed checkout. Do not infer that the order has been paid, shipped or delivered.
- Exclude cancelled orders before sending, live test orders, and orders placed before the current installation. Explicit development-store tests stay isolated.
- Unattributed and organic-only purchases remain excluded from ad delivery. Store them in Shopify-based reporting. Do not introduce all_purchases mode in this work.
## Revenue and estimated profit

Treat a completed order as booked order revenue/value and estimated profit immediately. These are operational estimates, not proof of cash collection. Profit must use available costs and the documented revenue basis; unknown costs remain unknown rather than becoming zero.

Subtract confirmed cancellations, refunds and returns from Metrico reporting. A return request alone is not a confirmed return. Partial returns affect only the relevant quantities/value. When a return and its refund describe the same adjustment, subtract it once. Use canonical Shopify money and record adjustment identity; do not invent a return value.

Refunds, edits and returns never create a second Purchase. They do not automatically retract an event already accepted by an ad platform. A future delivery-confirmed mode is outside the agreed launch scope.

## Architecture and evidence

## Canonical data flow

Capture permitted storefront evidence → retain touches → link checkout to a Shopify order → resolve eligible destinations → insert delivery rows → claim and send → record acknowledgements. Shopify order ingestion and reconciliation run independently of browser collection.

- The Web Pixel observes page, product, cart and checkout activity. It captures Shopify clientId, checkout token and checkout_completed order ID when available.
- The app embed supports the optional Meta browser pairing flow. It may add the planned consent-aware cart backup; it must not send Purchase events independently.
- Shopify webhook intake verifies HMAC against the raw body, deduplicates delivery IDs, queues processing and reconciles canonical orders through GraphQL.
- Keep orders/create, orders/updated and refund reconciliation. A shared eligibility rule controls Purchase creation; no webhook topic bypasses it. Do not restrict all order ingestion to orders/paid.
## Evidence collection

Capture real URL click IDs and permitted cookies: fbclid, ttclid, Google click identifiers, _fbp, _fbc and _ttp. Retain UTMs, safe landing/referrer context, event time and installation generation. Preserve case-sensitive identifiers; validate character set and length, and omit malformed or unresolved macro values.

TikTok native utm_source=tiktok, utm_medium=paid, utm_campaign and numeric utm_id are supported by pending PR 173. Dedicated Metrico campaign IDs take precedence. Preserve merchant and platform-managed UTMs; additional Metrico IDs identify campaign, ad group, ad and creative without conflating those levels.

## Touch history and identity

Keep original observations and their source/basis. Linking adds relationships rather than rewriting the touch as a different ad interaction. Scope every link to store and installation, and apply retention, withdrawal and redaction. Append-only evidence is not an exemption from privacy deletion.

Existing continuity uses the retained visitor/session and exact checkout/order relationships. Verified customer/order links are approval-gated. Do not merge customers from IP, user agent, a shared device or anonymous similarity. Newsletter, login and SMS stitching are deferred.

## Collector boundary

Validate installation credentials, payload size, origin where applicable and rate limits. If a Shopify app proxy is introduced, verify its signature and timestamp. That signature proves the proxy hop, not that user-submitted evidence or money is truthful. Never accept browser-provided order totals as canonical purchase money.

## Routing and conversion facts

## Sending and reporting remain separate

Send to each connected, authorized destination with an observed paid touch and usable permitted matching context. A last-touch winner does not exclude another channel that also has qualifying evidence. Never borrow one platform's click ID for another platform.

The existing resolver uses a retained 30-day observed-touch window. Keep that policy explicit. Platform reporting attribution windows, touch retention and event delivery age are separate concepts. Do not replace the resolver window with a guessed provider default; verify settings before adding provider-specific configuration.

- Real click identifiers and explicit paid campaign context are evidence, not proof that an ad caused a sale. fbclid alone is not proof of paid Meta traffic.
- Referrer-only evidence may describe source reporting but does not independently establish paid-touch eligibility under the current policy.
- Conflicting provider signals or explicit organic labels are handled conservatively. Unknown evidence stays unknown; no guessed campaign or customer match.
## Eligibility and exclusions

Require a canonical completed-checkout order, permitted evidence, active installation, valid destination, entitlement and current consent. Reject pre-install orders, cancelled orders and non-isolated tests. Explicitly exclude POS, draft-origin orders, B2B orders and subscription renewals from the default online-store advertising path. Do not infer checkout eligibility from an unpaid status or order existence alone.

Zero-value completed orders are excluded from ad Purchase delivery by default. If later supported, make that an explicit policy. Record a reason for every decision; a missing browser relationship is not a failed platform acknowledgement.

## Facts frozen when the logical purchase is created

- Keep the existing shared store-and-order event ID function and its stride:event prefix. IDs are opaque; do not rename existing IDs or generate a separate browser Purchase ID.
- Use the actual Shopify checkout/order processing time, with createdAt fallback, for this order-placement policy. Every destination and retry uses the same purchase time. Touch time belongs to click context, not Purchase event_time.
- Freeze value, currency, item quantities and item values from the canonical completed order. Later edits/refunds affect reporting, not the original event.
Preserve the current default conversion value basis: Shopify order total after discounts, including tax and shipping, in shop currency. Value and currency must come from the same money set. Keep this distinct from profit and any reporting measure that excludes tax/shipping. Presentment currency or subtotal defaults are not approved changes.

Validate zero-decimal currencies and decimal precision. Small future timestamp errors require a bounded, documented rule applied once; hold or reject implausible future dates. Never advance a purchase to send time to avoid an age limit.

## Deduplication matching and privacy

## One logical purchase per destination

Use database uniqueness on destination plus event key and destination plus canonical order plus event name. The store relationship must be enforced on every lookup. Insert before sending; atomically claim work so concurrent workers cannot own the same row. Keep stale-claim recovery.

Webhook retries, reconciliation and worker retries reuse the same logical purchase. An ambiguous timeout or a crash after acceptance can cause another HTTP request; the ID and conversion facts remain unchanged. Platform deduplication is a backstop within its documented window, not a substitute for the ledger.

Map event names centrally per provider. The current senders use Purchase for Meta and TikTok. Verify endpoint/version and supported event names against official documentation before changing them. TikTok is server-only; Meta browser pairing currently covers PageView, ViewContent and AddToCart, not Purchase.

## Permitted matching data

Rebuild usable customer data at each attempt and recheck authorization before protected reads and before sending. Do not retain a byte-identical raw personal-data payload merely to make retry snapshots equal. Freeze conversion facts; matching data can be removed or refreshed for privacy and availability.

- Construct Meta fbc only from a real fbclid and its observed touch time, or use a valid captured fbc. Capture fbp and ttp rather than inventing them.
- Use approved Shopify order email, phone, customer identifier and permitted address fields. Read protected fields only after approval, merchant enablement and verified checkout proof.
- Normalize and hash fields according to each provider's rules. Never hash empty strings or send a Meta-specific field to TikTok without documented support.
- IP, user agent and browser/click identifiers are not hashed where their platform fields require original values. Do not fabricate shopper network context.
## Consent and lifecycle

Honor Shopify privacy permissions, consent changes and withdrawal. Do not treat the merchant's country as sufficient evidence of the shopper's consent requirements. Unknown permission never becomes assumed permission. Recheck active installation generation, destination, entitlement and redaction on retries.

Stop sends after uninstall or withdrawal. Preserve mandatory data-request and redaction flows. Retain only justified minimal dedup/redaction tombstones; personal data is removed. Current customer redaction erases affected delivery data and records order tombstones that prevent reimport. Do not recreate redacted orders through reconciliation.

Merchant tracker ownership is declared, not automatically proven. Warn about native sales channels, hardcoded pixels and other apps. Different integrations' event IDs cannot be assumed to deduplicate. Never claim platform customer matching from identifier coverage or an API acknowledgement.

## Recovery retries and observability

## Recovery when browser collection is missing

Add consent-aware cart attributes as supplemental evidence, with controlled keys and no raw email/phone. Verify note attributes against canonical Shopify orders. Test accelerated checkout, Buy Now and Shop Pay; they may bypass cart updates. Never use a cart attribute alone to authorize another customer's protected data.

Fetch Shopify customerJourneySummary visit details as a delayed fallback, with readiness checks and bounded retries. Parse available source, landing and UTM fields as their actual evidence type. They do not create a real click ID or establish consent by themselves. Shopify can have limited or missing journey data; allow for up to 48 hours of availability delay.

A storefront app proxy may improve collection resilience. Shopify strips Cookie and Set-Cookie headers, so it cannot supply the proposed HttpOnly visitor cookie. Custom CNAME routes do not guarantee longer Safari persistence. Preserve direct collection as needed for sandbox/checkout compatibility and test the complete request path.

## Retry behavior

- Retry transport errors, ambiguous timeouts, 429 and relevant transient provider errors with exponential backoff, jitter and bounded attempts. Honor valid Retry-After values.
- Pause invalid credentials without discarding pending work; resume after reconnection if consent and event age still permit. Classify provider errors safely rather than treating every 4xx alike.
- Verify provider event-age and dedup windows from official docs, encode named constants, and apply a safety margin. Existing Metrico delivery has a seven-day cutoff and a 48-hour funnel enqueue window; these are current implementation limits, not claims about every provider.
- After the deadline or permanent failure, record a terminal reason. Retain enough nonpersonal state to prevent accidental resend. Replay reuses IDs and revalidates eligibility; it never bypasses privacy or age limits.
## Diagnostics and rollout

Track collected, permitted, eligible, queued, prepared, accepted, retrying and terminal outcomes separately. Coverage is eligible orders accepted by a destination divided by eligible orders for that destination and reporting cohort. Include pending/terminal outcomes and explicit exclusions; do not report delivery over all Shopify orders as 100 percent.

Record safe provider references and reason codes, not raw secrets, customer data or provider messages that echo them. Alert on failures, stale queues, terminal growth and credential errors. Platform-reported conversions are attribution claims; summed channels do not replace Shopify order totals.

Add dry-run/shadow mode with no provider calls, per-merchant activation and a global sending switch. Shadow results must not appear acknowledged. Before recording, verify collector-to-order-to-platform delivery and MCP access separately. MCP refresh/reconnect improvements reduce interruptions but cannot guarantee a connection never expires or disconnects.

## Implementation status and priority

Baseline checked 14 October 2026. Backend main at fbcceca6 and pending PR 173 at 30a50160. PR 173 is open and its CI passed; deployment and fresh browser pairing still require verification. These statuses describe the audit baseline, not a future release guarantee.

## Existing foundation

Order ingestion, storefront evidence, checkout proof, multi-channel touch routing, stable IDs, unique delivery rows, worker recovery, consent checks, gated matching and diagnostics exist. Meta/TikTok test and funnel acceptance has been observed. Real customer matching, real-ad attribution and processed platform deduplication remain unverified.

## First priority purchase and reporting rules

Enforce the approved completed-checkout policy without a PAID gate. Define excluded order types and zero-value behavior. Freeze canonical initial money, currency and item facts. Add idempotent partial/full return, refund and cancellation adjustments. Keep order-based totals independent of platform claims and label profit estimates consistently.

## Second priority retry hardening

Preserve frozen facts while rebuilding permitted user data. Add jitter, Retry-After handling, provider-specific verified deadlines and safe replay guards. Test races, timeouts, stale claims and a crash after provider acceptance.

## Third priority evidence recovery

Add the consent-aware cart/note-attribute path and delayed Shopify visit-detail fallback. Preserve installation scoping and checkout proof. Validate normal and accelerated checkouts, missing browser collection and unavailable journey data.

## Fourth priority rollout and verification

Implement shadow mode, activation/kill controls, actionable diagnostics and operational alerts. Run staged full-flow checks before enabling changes. Tests validate our implementation; official test tools validate acceptance, not real ad attribution or customer match success.

## Separate fixes and external dependencies

Keep PR 173 focused. Deploy backend, then republish metrico-pixel preserving its UID; no frontend change is needed. Verify browser behavior afterwards. Clock skew was observed, but the complete SDK failure cause is not proven.

Protected customer data and TikTok ad-edit approval are pending. Manual TikTok tracking remains available. Automatic editing needs a supported-ad preview/apply/readback test after approval. Google remains gated until separately validated.

Defer probabilistic attribution, fingerprinting, newsletter/login/SMS stitching, surveys/holdouts, ML, all_purchases and delivery-confirmed COD. Use focused PRs and recheck current heads before editing.

## Acceptance and release criteria

Each changed rule needs meaningful automated coverage. A passing suite does not establish real-platform attribution or universal ad-block resilience. Use synthetic identities only in explicitly isolated provider test mode.

- Completed COD and deferred-payment checkouts qualify without PAID status; pre-checkout events and unverified order IDs cannot create Purchase money.
- Cancelled, pre-install, live test, excluded-source and zero-value fixtures produce recorded skip decisions.
- Duplicate and concurrent webhooks plus reconciliation create one logical purchase per destination. Same-order retries reuse the existing ID across processes.
- Multiple qualifying paid channels receive their own permitted deliveries. Organic-only and ambiguous evidence do not become paid eligibility.
- Purchase ID, time, value, currency and item facts remain stable after order edits and across retries. Touch time never replaces purchase time.
- Partial and full returns/refunds/cancellations adjust reporting once. A return plus its refund cannot subtract the same value twice.
- Canonical money/currency pairing, zero-decimal currencies, discounts and item quantities have independent fixture expectations.
- Withdrawal, uninstall, redaction and entitlement changes between claim and send stop the attempt. Reconciliation does not resurrect redacted orders.
- Normalization/hashing uses independent known-answer vectors. fbc uses only captured evidence. Protected reads require approval and exact proof.
- Timeouts, 429 with Retry-After, 5xx, authentication errors, malformed responses and deadline expiry follow their specified states.
- Worker death before and after acceptance recovers safely. Retries may produce multiple requests, but not a new logical ID or conversion.
- Collector abuse, invalid proxy signatures, invalid installation credentials, oversized batches and malformed identifiers are rejected safely.
- Cart and journey fallbacks cover normal checkout, Buy Now, Shop Pay, missing cookies, blocked collection and delayed/unavailable journey data.
- Development checkout tests stay isolated and carry valid provider test codes. Expired test credentials never become live deliveries.
- Shadow mode makes no provider calls. Kill switches and paused credentials prevent sends without mislabeling events accepted.
- No logs or persisted provider errors expose access tokens, raw customer data or echoed sensitive request bodies.
## Platform checks before release

Use Meta/TikTok official Test Events tools to verify accepted names, IDs, time, value and available user-data fields. Repeated received entries do not by themselves prove failed deduplication; one entry does not prove success. Real-ad clicks are needed to validate actual campaign attribution, and usable approved customer data is needed to evaluate matching.

Release requires exact-head CI, reviewed migrations/configuration, staged full-flow evidence and rollback/kill controls. Dry-run reconciliation must explain eligible-order and delivery differences. Longer shadow observation and real-customer validation remain rollout work beyond a development-store recording.

## References and change control

## Official references

## Shopify CustomerJourneySummary

Visit fields and readiness. Journey evidence is not guaranteed.

https://shopify.dev/docs/api/admin-graphql/latest/objects/CustomerJourneySummary

## Shopify conversion summary

Missing/limited details and delayed availability.

https://help.shopify.com/en/manual/fulfillment/managing-orders/analytics/conversion-summary

## Shopify app proxy authentication

Proxy signature and stripped Cookie/Set-Cookie headers.

https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies

## WebKit tracking prevention

Storage and CNAME/IP-cloaking restrictions.

https://webkit.org/tracking-prevention/

## TikTok event deduplication

Matching event names/IDs and documented 48-hour overlapping-event windows.

https://ads.tiktok.com/resources/help/article/event-deduplication?lang=en

## Shopify manual payments

COD payment state is separate from order placement; Metrico's approved default does not wait for it.

https://help.shopify.com/en/manual/payments/manual-payments

## Implementation sources

Backend Ahmed2902/ShopifyBackend. Reviewed modules include conversion-delivery service/repository, source-routing, matching, signal-enrichment, browser-signals, pixel ingestion/journeys, Shopify order reconciliation/privacy and the Web Pixel/app embed extensions.

Pending focused fix: https://github.com/Ahmed2902/ShopifyBackend/pull/173

## Version history

Version 1.0 adopts completed checkout including COD, deducts confirmed returns/refunds/cancellations, preserves current IDs and touched-only sending, and corrects proxy, retry and dedup assumptions.

For updates, record PR/head, validation, release needs and remaining gaps. Mark implementation only after code verification and production validation only after live evidence. Do not promise deferred capabilities, guaranteed attribution, matching, approval or ad-block immunity.

