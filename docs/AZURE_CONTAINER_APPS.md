# Azure Container Apps deployment

Stride should run the same backend image as two separate Azure Container Apps:

- **stride-api** — public HTTPS ingress, default image command `node dist/api.js`
- **stride-worker** — no public ingress, command override `node dist/worker.js`, minimum replicas **1**

The worker must not scale to zero because durable email retries, reconciliation and background processing depend on it staying available.

## Build

From the repository root:

```bash
docker build -t stride-backend:latest .
```

The image defaults to the API runtime. The worker uses the same image with a command override:

```text
node dist/worker.js
```

## Database migrations

Run migrations exactly once before promoting a revision, from a checked-out repository/release job that has the Prisma schema available:

```bash
npm ci --include=dev --no-audit --no-fund
npm run prisma:migrate:deploy
```

`NODE_ENV=production` normally causes npm to omit dev dependencies. The explicit `--include=dev` is required because `prisma` is a development dependency and both the repository `postinstall` and `prisma:migrate:deploy` invoke the Prisma CLI.

The API/worker runtime image intentionally omits development dependencies, including the Prisma CLI. Do **not** run migrations from the runtime container or on every process startup; migrations belong in a one-shot deployment/release job before the new API and worker revision is promoted.

## Shared environment

Both Container Apps must receive the same values for application secrets and provider configuration, including:

- `DATABASE_URL`
- Redis configuration
- JWT / encryption keys
- Shopify client ID, secret, scopes and API version
- Meta configuration
- Resend configuration once email delivery is enabled
- Pixel retention / processing configuration

Runtime-specific URL values should describe the public production deployment:

```env
NODE_ENV=production
PORT=3001
APP_URL=https://<api-host>
FRONTEND_URL=https://<frontend-host>
CORS_ORIGIN=https://<frontend-host>
SHOPIFY_REDIRECT_URI=https://<frontend-host>/api/shopify/callback
PIXEL_COLLECTOR_URL=https://<api-host>/v1/pixel/events
```

Do not use localhost URLs in a production Container App.

## API ingress and probes

Expose port `3001` on `stride-api` with external HTTPS ingress.

Use:

- liveness: `GET /health/live`
- readiness: `GET /health/ready`

Do not expose `stride-worker` publicly.

## Scaling

For the first launch:

### API
- minimum replicas: 0 or 1 depending on acceptable cold starts
- maximum replicas: keep small initially and increase from observed load

### Worker
- minimum replicas: **1**
- start with maximum replicas: **1** unless worker concurrency has been explicitly validated

Keeping one worker initially avoids accidental duplicate/concurrent background processing assumptions during the first merchant rollout.

## Shopify app configuration after deployment

After the Azure API hostname is known:

1. Set `APP_URL` and `PIXEL_COLLECTOR_URL` to the Azure HTTPS origin.
2. Update Shopify webhook subscription URIs to the Azure API origin.
3. Keep the production frontend callback in Shopify `redirect_urls` and set `SHOPIFY_REDIRECT_URI` to the exact same callback.
4. Deploy/release the Shopify app configuration.
5. Reinstall/repair the Stride Pixel so its remote settings contain the production collector URL.
6. Re-test product/inventory/order/refund webhooks without pressing **Sync data**.

## First production smoke

Before inviting merchants, verify:

```text
/health/live                    200
/health/ready                   200
frontend -> API auth            works
Shopify OAuth                   works
Shopify sync                    works
Shopify webhook delivery        works
Pixel install/repair            works
Pixel lastEventAt               advances
worker process                  continuously healthy
```
