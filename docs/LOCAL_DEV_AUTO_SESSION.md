# Local dashboard auto session

When the backend runs with `NODE_ENV=development`, Stride can mint a short-lived normal access token for the local dashboard without asking the developer to sign in.

## Default behavior

`DEV_AUTO_SESSION_ENABLED` defaults to enabled only in `development`. It defaults to disabled in `test` and `production`.

The frontend calls `POST /v1/auth/dev-session`, the backend chooses a real local Store membership, and returns the same access-token shape used by the legacy local auth path. Normal store-membership middleware still protects every store-scoped request.

If the local database contains exactly one Store with a membership, no extra configuration is required.

If it contains multiple Stores, set:

```env
DEV_AUTO_SESSION_STORE_ID=<uuid of the Store to open locally>
```

To disable the convenience path even in development, set:

```env
DEV_AUTO_SESSION_ENABLED=false
```

## Production boundary

A non-development process never enables auto sessions by default. Explicitly setting `DEV_AUTO_SESSION_ENABLED=true` outside `NODE_ENV=development` makes configuration fail during startup.

The Shopify App Bridge session bootstrap remains the production merchant-authentication path. The development endpoint does not create a refresh cookie and only mints the normal short-lived access token already understood by `requireAuth`.
