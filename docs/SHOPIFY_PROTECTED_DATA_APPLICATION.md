# Stride — protected customer data application draft

Prepared from the current GraphQL queries, Pixel payloads and privacy implementation. Use this wording in Shopify's protected-data access request, adapting it to the actual form. It is an application draft, not an approval or an attestation that deployment operations have been verified.

## App purpose

Stride helps Shopify merchants review product sales, refunds, inventory and connected advertising performance in one workspace. It links product and paid-media activity to provide calculated, read-only recommendations. It does not automatically change advertising budgets or make purchasing decisions for the merchant.

## Why protected data is necessary

Stride needs access to Order resources to calculate revenue, units sold, refunds and product-level economics; relate orders to purchased products; and compare connected advertising activity with Shopify commerce activity. Without order access, the app cannot provide its core commerce and Product × Ads functionality.

## Requested level and fields

Request **level 1 protected customer data**. The current order queries use order IDs/reference numbers, lifecycle timestamps and statuses, currencies, monetary totals, discounts, quantities, line items, product/variant references, refund details and aggregate customer-journey values such as customer order index and days to conversion.

Do not request level-2 customer names, email addresses, phone numbers, billing addresses or shipping addresses. Do not request `read_customers`: the current product does not need a Customer-profile query. Normalized order analytics do not contain a Customer profile; legacy/raw webhook data is handled by the privacy-redaction paths rather than being declared anonymous.

## Optional historical order access

Use this justification only when requesting `read_all_orders`:

> Merchants use Stride to compare historical product sales, refunds and paid-media activity across longer reporting periods, including seasonal and annual comparisons. Orders older than the standard access window are required to calculate these merchant-selected historical reports consistently. The app reads order and line-item facts for analytics and does not request direct customer contact or address fields.

If Shopify has not approved this scope, configure the approved scopes and use the accessible history. Do not represent an incomplete historical period as a complete total.

## Storefront and advertising disclosure

When enabled, the Stride Pixel captures pseudonymous visitor/session IDs, behavior events, sanitized URLs, product/variant/collection references, campaign parameters, click IDs and checkout/order linkage. These identifiers can become order-linked and are included in the relevant access/deletion flows; they are not described as universally anonymous.

Purchase disclosures to configured Meta, TikTok or Google Ads destinations require the merchant's enabled destination and explicit retained buyer permissions. Analytics permission alone is insufficient: analytics, marketing and sale-of-data permissions must all allow sharing. Missing permission defaults to denied. Disclosures use supported click identifiers, purchase time/value/currency and deduplication identifiers; the launch implementation does not request customer email/phone for advanced matching.

Privacy withdrawal sends a minimal visitor/session revocation through authenticated collector ingress even when no further analytics event occurs. Durable revocation markers block late source batches and provider retries. Already accepted provider requests require the provider's applicable deletion process; an offline client cannot prove that its withdrawal reached the server.

## Controls evidenced by the application

- Shopify App Bridge ID tokens establish merchant identity; repositories and access guards enforce store boundaries and roles.
- Shopify/provider access and refresh tokens are stored encrypted and are not returned to the browser. The encryption key is an external deployment secret.
- Compliance webhooks use the exact signed raw body for HMAC verification, durable deduplication and asynchronous processing.
- `customers/data_request` produces a tenant-scoped export available to owner/admin users, including retained order-linked storefront evidence and withdrawal markers.
- `customers/redact` deletes matching orders and linked raw sessions/events/exports/withdrawal markers and leaves order-erasure tombstones to prevent re-import.
- `shop/redact` erases the tenant graph; withdrawal markers cascade with the Store. Erasure processing can continue after uninstall without an active Shopify token.
- Uninstall/reinstall invalidate obsolete credentials, cached entitlements and affected provider/MCP grants. Fresh bootstrap reads Shopify's current installation ID instead of assuming an old `ACTIVE` flag proves continuity.

## Retention and operational answers

The default raw Pixel event retention is 90 days and is configurable. Revocation markers are retained for at least 40 days, or the longer configured raw-event period, to outlive the purchase-delivery and late-ingress windows. Cleanup is bounded. Other retention, backups and mandatory business records must match the actual production policy.

Answer organizational and deployment questions from real records: legal operator, active hosting/database/observability vendors, processing regions, access-review practice, backup expiration, incident response and contracts with subprocessors. These cannot be certified from source code. Do not claim a security certification, fixed breach-notification deadline or contractual transfer mechanism unless it actually exists.

Before submitting, verify the live privacy/export/deletion flows and the published `/privacy`, `/data-processing`, `/subprocessors` and `/data-deletion` pages against those records. Support/reviewer contacts remain pending the final domain.

Source: [Shopify protected customer data](https://shopify.dev/docs/apps/launch/protected-customer-data). Implementation details: [privacy compliance](SHOPIFY_PRIVACY_COMPLIANCE.md).
