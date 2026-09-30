# Shopify-native authentication

Stride is now committed to a Shopify-native merchant authentication model.

## Production target

1. Merchant installs/opens Stride from a Shopify-owned surface.
2. The embedded frontend uses the current Shopify App Bridge.
3. App Bridge sends a short-lived Shopify ID token in the `Authorization: Bearer ...` header.
4. The backend verifies HS256 signature, `aud`, `exp`, `nbf`, and the matching `iss`/`dest` shop host.
5. The backend exchanges the ID token for an online access token to resolve the current Shopify staff identity.
6. On first install/reinstall, the backend also exchanges for an expiring offline access token and persists it server-side for GraphQL Admin API background work.
7. Shopify `shop + staff user` is mapped to the existing Stride `User + StoreMembership` model, so all existing store-scoped authorization continues to work.

## Identity rules

- `Store.shopifyShopId` and `Store.myshopifyDomain` remain the tenant identity.
- `ShopifyUserIdentity(storeId, shopifyUserId)` links the Shopify staff member to an internal Stride user.
- Shopify account owners are mapped to Stride `OWNER`.
- Other Shopify staff are created as `MEMBER` unless an existing Stride membership already grants a stronger role.
- Google sign-in/password auth are legacy migration paths only; Google Ads OAuth remains a separate provider integration.

## Rollout

Set `SHOPIFY_EMBEDDED_AUTH_ENABLED=true` only after the frontend uses current App Bridge ID-token authenticated requests.

During rollout, `requireAuth` accepts both:

- existing Stride access JWTs; and
- Shopify App Bridge ID tokens.

Do not remove legacy auth tables/routes until install, reopen, uninstall, reinstall, owner, staff, billing, and provider-connection flows have been validated in production.

## Security behavior

If Shopify rejects or the backend cannot validate a short-lived ID token, Stride returns `401` and sets `X-Shopify-Retry-Invalid-Session-Request: 1` so App Bridge can refresh the ID token and retry once.

Shopify access/refresh tokens stay encrypted server-side and are never returned to the browser.
