# Shopify-native authentication

Stride is a Shopify App Store app. Shopify is the primary merchant identity and installation authority for the embedded application.

## Production flow

1. The merchant installs/opens Stride from a Shopify-owned surface.
2. The embedded frontend obtains a short-lived Shopify App Bridge ID token.
3. The frontend sends that token as `Authorization: Bearer <id-token>` to `POST /v1/integrations/shopify/session/bootstrap`.
4. The backend verifies the token signature with `SHOPIFY_CLIENT_SECRET`, requires `aud=SHOPIFY_CLIENT_ID`, validates time claims, and requires the `iss` and `dest` hostnames to match.
5. The backend exchanges the ID token for:
   - an expiring offline token + refresh token for shop-level background GraphQL Admin work;
   - an online token only to read the current Shopify staff identity.
6. The Shopify shop maps to Stride `Store.shopifyShopId` / `Store.myshopifyDomain`.
7. The Shopify staff ID maps through `ShopifyUserIdentity` to an internal compatibility `User` + `StoreMembership`.
8. Normal store-scoped routes continue to use the established tenant boundary.

## Roles

Shopify's online token gives Stride a trustworthy `account_owner` bit but not a direct mapping to Stride's historical ADMIN role.

- Shopify account owner -> `OWNER`
- every other Shopify staff/collaborator -> `MEMBER`

Stride does **not** infer ADMIN from browser input, email, collaborator state, or an old Stride account. Elevated non-owner permissions can be introduced later only from an authoritative Shopify permission source or an explicit Stride authorization model.

The bootstrap endpoint refreshes the owner bit once per embedded app load. Ordinary API calls reuse the persisted identity mapping.

## PII minimization

The compatibility `User` row uses a deterministic `@identity.invalid` address derived from shop + Shopify staff ID. Stride does not persist the staff member's Shopify email or name for authentication.

This avoids:

- accidental account linking by email;
- inheriting stale legacy OWNER/ADMIN privileges;
- collecting staff PII that is unnecessary for tenant authentication.

`ShopifyUserIdentity.emailVerified` records only Shopify's boolean verification signal; it does not store the email itself.

## Offline tokens

New/reinstalled shops use token exchange to obtain an expiring offline access token. Stride stores only encrypted access/refresh tokens plus their actual expiry times and granted scopes. Existing refresh logic rotates the offline token before it expires.

The offline token is the credential used by syncs, webhooks/reconciliation, order backfills, inventory reads, and other background Shopify GraphQL Admin work. The browser never receives it.

## Invalid embedded sessions

When a Shopify-authenticated request fails with `401`, the auth middleware adds:

`X-Shopify-Retry-Invalid-Session-Request: 1`

App Bridge can then obtain a fresh ID token and retry the browser request once.

## Migration compatibility

The existing Stride access-token login path remains temporarily accepted by `requireAuth` while the frontend is converted to App Bridge. It is not the target App Store authentication model.

The legacy `POST /v1/integrations/shopify/install` + authorization-code callback also remains temporarily available to the old standalone frontend. The public App Store flow must not ask merchants to type a `myshopify.com` domain; installation begins in Shopify and uses `/session/bootstrap`.

After the frontend is fully embedded and production validation is complete, remove the legacy merchant registration/login/Google-login flow and the manual Shopify install bridge in a dedicated cleanup migration. Google Ads OAuth, Meta OAuth, TikTok OAuth, and MCP credentials are product integrations and remain separate from merchant authentication.

## Frontend contract

The companion frontend migration must:

- run Stride embedded in Shopify Admin using the current App Bridge;
- obtain/attach an App Bridge ID token to backend API requests (explicitly for the separate backend origin if automatic fetch interception doesn't cover it);
- call `/v1/integrations/shopify/session/bootstrap` once when the embedded app boots;
- stop requiring `/signup`, `/login`, password recovery, email verification, or Google sign-in before entering Stride;
- keep Google **Ads** OAuth as an advertising integration;
- use the returned Stride `store.id` for existing store-scoped API routes.

## Security invariants

- Never trust `shop`, store ID, user ID, or role supplied by the browser body/query string.
- Never call Shopify's token endpoint before verifying the ID token.
- Never expose the offline Shopify access/refresh token to the browser.
- Never identify a tenant by display name or primary storefront domain; use the verified `myshopify.com` / Shopify shop identity.
- Store-scoped repositories remain responsible for tenant predicates even after middleware authorization.
