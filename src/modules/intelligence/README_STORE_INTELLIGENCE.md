# Storefront intelligence evidence semantics

Storefront decisions are deterministic interpretations of Stride Pixel session rollups joined to exact Shopify purchase identity.

- cart abandonment uses cart-view sessions that do not contain a linked valid Shopify purchase
- checkout abandonment uses checkout-start sessions that do not contain a linked valid Shopify purchase
- percentage-point comparisons are preferred for rates
- minimum session thresholds suppress low-volume diagnoses
- storefront findings are observational; they do not claim the cause of abandonment or conversion changes
- product findings are scoped to resolved product behavior and inherit Pixel data-quality limitations
