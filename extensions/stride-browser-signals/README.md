# Stride storefront browser signals

Create a Shopify theme app extension with the Shopify CLI and retain its generated UID. Copy this extension's `assets`, `blocks` and `locales` into it; adapt the TOML template to the CLI-generated configuration. Deploy it under the same app as Stride's Web Pixel and activate the embed in the merchant's live theme.

No merchant credential fields are needed. The installed Web Pixel supplies short-lived installation-scoped ingress context through top-frame sessionStorage after durable collection. Backend settings must enable Meta funnel sharing, browser pairing and exclusive tracking ownership. Defaults remain off.

Supported paired browser events: Meta PageView, ViewContent and AddToCart. Checkout/Purchase stay server-side. Existing Meta browser scripts, denied consent, private URL context or SDK/ad-block failures prevent browser dispatch. No cross-app/native Purchase deduplication is claimed.

See `docs/CONVERSION_SIGNAL_VALIDATION.md` for consent/retention boundaries, deployment gates and live-provider validation. The Liquid embed schema is validated in app-block context; browser behavior is covered by the VM consent/overlap/deduplication tests and the backend PostgreSQL authorization tests.
