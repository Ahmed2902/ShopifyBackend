# Stride backend process topology

Stride has two different runtime responsibilities:

1. the HTTP API
2. long-lived background pollers that drain webhook/reconciliation/pixel work

They should run as separate persistent processes in production. Keeping them separate prevents every horizontally scaled API replica from starting another copy of every polling loop.

## Local development

The existing combined entrypoint remains available for convenience:

```bash
npm run dev
```

That runs `src/server.ts`, which starts the HTTP API and the workers together outside Vercel.

For production-like local debugging, run them separately in two terminals:

```bash
npm run dev:api
npm run dev:worker
```

## Production build

Build once:

```bash
npm ci
npm run build
npm run prisma:migrate:deploy
```

Then run two services from the same build/revision.

### API service

```bash
npm start
```

`npm start` is intentionally API-only. `npm run start:api` is an equivalent explicit command. This safe default prevents a generic process host or a horizontally scaled API service from accidentally starting another copy of every background poller.

Health checks:

- liveness: `GET /health/live`
- readiness: `GET /health/ready`

The readiness endpoint verifies PostgreSQL connectivity.

### Worker service

```bash
npm run start:worker
```

The worker process owns the persistent Shopify webhook, TikTok webhook, scheduled reconciliation, Pixel journey, Pixel behavior, Pixel attribution, and Pixel retention pollers.

Start with one worker replica during merchant testing. Increase worker concurrency only after the claim/lease behavior for each queue has been deliberately load-tested.

### Combined production process

A combined API + worker process remains available only when deliberately requested:

```bash
npm run start:combined
```

Do not use the combined command for a horizontally scaled API deployment, because every replica would also create a full set of polling loops.

## Vercel

`src/server.ts` remains the Vercel function entrypoint. When `VERCEL=1`, it exports the Express app without binding a port or starting background pollers.

Do not use Vercel request functions as the only runtime for Stride's persistent polling workers. Host `npm run start:worker` on a persistent process platform.

## Recommended Stride topology

```text
Vercel
  ShopifyFrontend

Persistent backend host
  service: stride-api
    command: npm start

  service: stride-worker
    command: npm run start:worker
    initial replicas: 1

PostgreSQL / Supabase
Redis REST
Resend
Shopify / Meta / optional TikTok
```

Both backend services must use the same application revision and the same database/integration environment values. Only the API service needs an externally reachable HTTP port.
