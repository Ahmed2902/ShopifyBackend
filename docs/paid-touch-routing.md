# Source-based event delivery and review testing

## Behavior

Live purchases are routed only to channels with retained, permitted paid-touch evidence linked to the checkout. Routing is observed evidence, not provider or causal attribution. A TikTok → Meta journey may send to both; the last observed paid touch is Meta. Direct returns do not overwrite an earlier retained paid touch. Unknown/organic sources do not automatically route. Multiple click-provider identifiers on one observation, or contradictory source labels, block automatic routing rather than guessing. A Meta click identifier alone is insufficient to establish a paid ad: include a paid medium or a recorded ad/campaign link ID. URL tags are merchant declarations, not verified platform campaign IDs.

Lookback is up to 30 days, limited by retained evidence and installation generation. Repeated identical landing context retains its earliest observed timestamp; this is not a promise of the actual ad-click time or a new click on each page. Histories exceeding 1,000 distinct attribution observations are withheld instead of truncated for routing. No cross-device relationship is guessed. Source evidence may be lost when collectors are blocked, privacy protections remove identifiers, or the browser identity changes. The order can still be captured without being eligible for advertising delivery.

Matching, account access, current consent and subscription are checked separately before sending. Provider APIs decide matching and attribution. Stable provider event IDs prevent replayed Metrico deliveries, but other apps do not automatically use those IDs.

## Deployment

Deploy backend and additive routingEvidence migration before frontend. No new environment variables or extension deployment. Existing pending live events are rechecked against routing; events without eligible evidence stop with SOURCE_ROUTE_BLOCKED. Already accepted historical events are not recalled or resent. The existing Google adapter uses Data Manager, not legacy Google Ads click uploads; its OAuth scope and conversion action prerequisites still apply.

## Easy test path in the UI

1. Enable a channel destination. Meta/TikTok: copy its Events Manager Test Events code. Google: validation only.
2. First use the connection check; acceptance checks connectivity, not attribution or a real order.
3. On a verified Shopify development store, enable test payments. Accept advertising consent and complete checkout from the storefront, not a manually created Admin order.
4. Expand the complete-checkout test, load orders and select the new test order.
5. Check A shows the recorded source journey and each channel's source eligibility. A manually opened store can correctly show no paid source. A test URL with `utm_source=meta&utm_medium=paid_social&utm_campaign=metrico-routing-test` can exercise merchant-tagged Meta routing on the dev store. Use corresponding `tiktok`/`google` sources in new checkouts to inspect those paths. These tags do not simulate genuine click matching or campaign attribution. Never invent click IDs and upload them.
6. Check B is deliberately isolated: it bypasses live source routing for this explicit test-payment order only. Meta/TikTok use encrypted, expiring test codes and the normal worker. Google validates only and never uploads a test conversion. A successful Check B cannot certify Check A or live attribution.
7. Verify the Meta/TikTok server Purchase in the right Test Events destination. Record the order number and test receipt. Repeat Meta with only fbevents.js blocked, leaving Metrico's collector available.
8. Test fresh/direct visits, conflicting tags, consent denial/withdrawal and return visits. The database suites validate routing to each channel, mixed journeys, generation/retention limits, isolation and stable queue identity without uploading mock click IDs to external platforms.

## Release evidence limits

Meta and TikTok Test Events can prove server receipt without campaigns. Google validate-only success proves request validation only; live ingestion needs a real eligible conversion and receipt. Genuine campaign/ad attribution requires real ad-click evidence, and no results here imply 100% recovery or ROAS lift. A UTM campaign/ad label must not be presented as an API-verified campaign/ad.
