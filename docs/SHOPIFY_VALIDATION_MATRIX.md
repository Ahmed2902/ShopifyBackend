# Shopify validation matrix

This is the minimum Shopify behavior the application read surface must preserve.

| Case | Source | Expected application behavior |
| --- | --- | --- |
| Active / draft / archived products | Catalog sync | Count separately; product list can filter status |
| Multi-variant product | Product sync | Keep stable product and variant identities |
| Tracked inventory | Inventory sync | Expose operational quantities by variant and location |
| Untracked inventory | Inventory sync | Do not interpret zero as an out-of-stock signal |
| Zero tracked inventory | Inventory sync | Eligible for out-of-stock risk |
| Low tracked inventory | Inventory sync | Eligible for low-stock risk using UI-selected threshold |
| Multi-location inventory | Inventory sync | Preserve location-level state and aggregate only for summary display |
| Incoming / committed / reserved stock | Inventory sync | Preserve separately from available and on-hand |
| Compare-at price | Catalog sync | Preserve variant merchandising price context |
| Normal order | Order backfill/webhook | Include in demand and commerce metrics |
| Test order | Order backfill/webhook | Keep for debugging but exclude from demand/commerce metrics |
| Imported historical order | Order backfill | Attribute demand by `processedAt`; fall back to Shopify create time only when absent |
| Cancelled order | Order backfill/webhook | Preserve cancellation state for downstream demand rules |
| Refund | Refund backfill/webhook | Preserve refunded units and value; subtract in net-sales read model |
| Reconciliation | Scheduled sync | Repair missed catalog, inventory and order changes without duplicating domain rows |

The connected development store also contains Shopify-generated edge cases (draft, archived, out-of-stock, untracked, multi-location, third-party fulfillment, compare-at pricing) plus a `Classic Hoodie` test product with Black/White/Gray and S/M/L/XL variants. Database tests mirror the demand-sensitive cases so CI does not depend on an external Shopify store.
