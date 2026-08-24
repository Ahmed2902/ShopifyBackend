# Rate limiting

Rate limiting is a shared security boundary, not process-local state.

The API uses Redis REST for fixed-window counters so limits are shared across replicas and survive application restarts without adding database tables. Each request sends one atomic Redis `EVAL`: increment the counter, set its TTL on the first hit, and return the remaining TTL. Redis removes expired buckets automatically.

Required environment:

```env
REDIS_REST_URL=...
REDIS_REST_TOKEN=...
```

## Policies

- General API: 600 requests / 5 minutes per bearer identity or source identity.
- Webhook ingress: 3000 requests / 5 minutes per source identity, enforced before JSON body parsing.
- Login: 10 attempts / 15 minutes per normalized email + source identity.
- General auth actions: 30 / 15 minutes.
- Email actions: 8 / 15 minutes.
- Refresh/logout: 60 / 15 minutes, charged only after CSRF validation succeeds.
- CSRF token issuance: 30 / 15 minutes, charged only after trusted-origin validation succeeds.

Raw emails, bearer tokens, reset tokens and refresh tokens are never placed in Redis keys; SHA-256 digests are used instead.

The limiter fails closed with `503 RATE_LIMIT_UNAVAILABLE` if Redis cannot be reached or returns an invalid response. This avoids silently dropping the security boundary during a Redis outage.
