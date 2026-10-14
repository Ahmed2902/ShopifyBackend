# Tracking and MCP recording handoff — 14 October 2026

## Scope and evidence

Metrico already captures canonical Shopify orders, recovers purchases from a permitted checkout-token relationship when `checkout_completed` is missing, and supports customer matching, observed network context and provider click identifiers. It does not need a UTM to record an order or prepare supported matching fields. Paid-touch routing remains separate: TikTok click IDs can establish an eligible touch without UTMs; Meta requires a paid label or ad-link identifiers because `fbclid` can also decorate organic links. Direct/organic purchases with no retained paid touch remain withheld as requested.

This release fixes pixel registration/event loss when browser storage rejects, keeping session and landing state in the worker. It uses Shopify's supplied client ID; it does not add fingerprinting or invent cross-device links. Existing cookies can supplement matching but are optional. If a stored withdrawal boundary cannot be read, old matching cookies are withheld. Consent changes still scrub queued/in-flight advertising data and send withdrawal markers. Without working storage, continuity/unsent withdrawal markers cannot survive worker destruction; no cross-reload guarantee is claimed.

MCP grants now include rotating refresh tokens even when a generic OAuth client requests only `mcp:read`. Approved scopes do not expand. Access tokens still expire after 15 minutes; refresh tokens expire after 30 days and membership is rechecked. Expired tokens return `invalid_token`, missing scopes return 403 `insufficient_scope`, and a temporary membership database failure returns retryable 503 without a false authentication challenge. These fixes cover reproducible failure paths; production logs have not established every cause of the reported disconnects.

Checkout receipts now expose canonical order/value/purchase time, acceptance time and boolean matching coverage. Synthetic diagnostic fallback is explicitly labeled. A manual test rerun intentionally creates a new ID; live purchases and their retries retain the existing stable ID. Legacy `stride:event:` IDs remain unchanged to protect deduplication.

## Release order

1. Merge/deploy the frontend companion first so new MCP consent screens disclose renewable access. It tolerates older backend receipts.
2. Merge/deploy this backend after its complete CI passes. No new database migration or secret is required.
3. Copy `extensions/stride-pixel/src/index.js` into the existing **metrico-pixel** extension in the actual Shopify CLI app project, preserving its generated UID and existing privacy/settings declarations. Build and deploy that Shopify app version. Backend deployment alone does **not** publish this extension source.
4. Reconnect an existing AI connection once if it was created without a refresh token. A deployed server cannot add a refresh token to a token already held by a client.

## Recording sequence without a paid campaign

1. Open Meta/TikTok Events Manager Test Events and obtain the separate test codes. Do not show access tokens or customer data in the recording.
2. Open a fresh storefront session with `?utm_source=meta&utm_medium=paid_social&utm_campaign=metrico-review`. Browse a product, add to cart and complete a **new** Shopify test-payment checkout with advertising consent allowed. For TikTok use `utm_source=tiktok`; a mixed journey can include both before checkout. These URLs check source recognition, not real ad-click matching.
3. Wait for Shopify synchronization. In Connections → checkout testing, load orders and select the exact new order by name, value and purchase time.
4. Show Check A's eligible channels, enter their test codes and run once. Show each accepted result, matching summary and expanded reference. Compare its event ID, order, value and purchase instant with the provider's Server Purchase entry. Acceptance time can be later; every channel's Purchase uses the same canonical purchase instant.
5. Explain that explicitly rerunning the same test can create another Test Events entry. It does not demonstrate duplicate live purchases.
6. Connect the AI client, approve the store's read-only request and ask for store context and a revenue/product summary. Reuse the connection after access-token renewal. The automated OAuth regression advances beyond 15 minutes and validates renewal without widening scopes; client behavior must also be checked live.

## Remaining real-world validation

Test Events reception validates transport/request handling, not actual platform customer matching, campaign attribution, view-through credit or cross-device accuracy. Those require genuine permitted buyer signals and real advertising interactions. Do not claim 100% matching, universal ad-blocker immunity or parity with a competitor's proprietary system.

Protected email/phone/customer fields still require Shopify approval and the existing `SHOPIFY_ENHANCED_MATCHING_APPROVED` setting plus destination opt-in. This release does not bypass approval. Google remains withheld from the current frontend launch. Current MCP/read-only connector access does not expose raw conversion receipts or complete reviewer authorization of a new client, so production receipt and client renewal checks cannot be inferred from aggregate reads.

References: [Shopify pixels](https://shopify.dev/docs/apps/build/marketing/pixels), [TikTok matching keys](https://ads.tiktok.com/resources/help/article/how-to-set-up-matching-events-with-events-api?lang=en), [OAuth refresh grants](https://www.rfc-editor.org/rfc/rfc6749#section-6), [Bearer errors](https://www.rfc-editor.org/rfc/rfc6750#section-3.1), [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
