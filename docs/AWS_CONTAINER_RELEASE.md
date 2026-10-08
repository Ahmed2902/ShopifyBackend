# Metrico AWS container release

This prepares deployment; it does not create an AWS resource or deploy the application. Use the later deployment walkthrough to choose/provision the server and configure secrets. Initial architecture is one Linux amd64 AWS host in Ireland, Docker Compose, Caddy HTTPS, API, worker and Next.js frontend, with Supabase remaining external. This avoids paying for a load balancer, NAT gateway and orchestration cluster at low volume. It is a single-host service, not a highly available cluster.

Follow [the ordered owner walkthrough](DEPLOYMENT_OWNER_STEPS.md) for GitHub variables, merges, AWS setup, DNS, secret files and the first release. [The public frontend template](../deploy/frontend-build.env.example) mirrors the repository variables for deployment-pair validation.

## Public website first

`deploy/public.sh` with `compose.public.yaml` publishes only the frontend and proxy using pinned images. It requires DNS, registry access and frontend/proxy digests, but no backend credentials, Shopify hosted-plan configuration or database changes. It verifies public policy URLs while `app.metrico.live` and `api.metrico.live` return 503. This lets the owner finish provider policy links before the full application. It refuses to run if any full-release API/worker container already exists, including a stopped container. It is not an update or rollback path.

Once full backend settings and backups are ready, `release.sh` uses the same project/service names and TLS volumes to start the full application and replace the temporary routing. No certificate volumes are deleted. CI validates both Compose/Caddy configurations and the public-stage image/transition guards.

## Images and GitHub configuration

Backend CI runs on pull requests and main pushes. After a successful main-push CI, Publish containers pushes `metrico-backend` (shared by API/worker) and `metrico-migrations` to GitHub Container Registry. Frontend's equivalent workflow publishes `metrico-frontend`. Tags include the exact git SHA. Production uses the digests recorded in each workflow summary, never `latest`. The two backend images must come from the same commit. All three repositories/branches must be reviewed and merged before building the paired release.

Image publication uses the repository GITHUB_TOKEN with packages:write and actions:read; no AWS credentials or provider secrets are passed to Docker builds. Publication is accepted only from main and verifies successful main-push CI for the exact checked-out commit, including manual retries. Pull requests build/validate images without publishing them. A newer pending, failed or cancelled CI run blocks publication even if an older run succeeded.

Frontend public repository variables must be configured before publication:

| Variable                          | Value                                                |
| --------------------------------- | ---------------------------------------------------- |
| NEXT_PUBLIC_API_URL               | https://api.metrico.live                             |
| NEXT_PUBLIC_SITE_URL              | https://metrico.live                                 |
| NEXT_PUBLIC_APP_URL               | https://app.metrico.live                             |
| NEXT_PUBLIC_SHOPIFY_API_KEY       | The existing Metrico Shopify client ID               |
| NEXT_PUBLIC_SUPPORT_EMAIL         | A real monitored mailbox                             |
| NEXT_PUBLIC_SHOPIFY_APP_STORE_URL | Published listing when available; otherwise empty    |
| NEXT_PUBLIC_ENABLE_TIKTOK         | true for reporting, or false if intentionally hidden |

NEXT_PUBLIC values are compiled into the image. Changing only a running container's environment does not update them: rebuild the frontend. Database, Shopify secret, Partner API token, provider client secrets and Redis token belong only in the backend runtime environment. Preserve the existing TOKEN_ENCRYPTION_KEY for stored credentials.

## Host prerequisites and layout

Use Docker Engine and Compose **2.30+** (raw env-file format), curl and age. Images currently target linux/amd64; choose an x86_64 instance, not an ARM Graviton instance unless the image workflow is extended and tested. Keep a stable public IP and configure DNS for `metrico.live`, `app.metrico.live` and `api.metrico.live` to it. Ingress: TCP 80/443; SSH only from your administrative IP. Do not expose 3000, 3001, PostgreSQL or the Docker socket publicly. Keep automatic OS security updates and a monitored billing budget. Check that your particular AWS credit grant covers the chosen service.

Copy `deploy/` to a private server directory and configure:

- `release.env`: actual immutable image digests, based on release.env.example. Each application variable must match its own repository; placeholder zero digests are rejected. Pin the HTTPS proxy too: run `docker pull caddy:2-alpine`, then `docker image inspect caddy:2-alpine --format '{{index .RepoDigests 0}}'`, and put that exact `caddy@sha256:…` value in `PROXY_IMAGE`. Review proxy updates deliberately and retain the previous digest for rollback.
- `backend.env`: actual backend secrets and public URLs, based on backend.env.example. Plain unquoted values; Compose raw format preserves literal characters. DATABASE_URL must be a supported Supabase direct/session TLS connection. Prisma CLI can use MIGRATION_DATABASE_URL if different. Keep approved scopes only; read_all_orders is included because the owner reports it granted.
- `backup.env`: PostgreSQL connection components for pg_dump, preferably an authorized backup connection, not browser credentials. These are separate to avoid supplying advertising secrets to the PostgreSQL client.
- `backup.recipient`: one age public recipient whose private decryption key is stored securely off this host. No private key belongs here.

Set directory permissions to 700 and secret files to 600. Never commit them, run `docker compose config` without `--quiet` in logs, or source env files as executable shell. Authenticate to GHCR using a read:packages token if images are private; store Docker credentials with an appropriate credential helper. Provider/Shopify secrets do not belong in GHCR login or build configuration.

Keep `SHOPIFY_ENHANCED_MATCHING_APPROVED=false` until the app's actual protected-data approvals and production privacy controls are verified. Set `SHOPIFY_ENHANCED_MATCHING_FIELDS` explicitly: the template limits requests to `email,phone,customer_id`, which is appropriate only when those fields and their advertising purpose are approved. Remove anything unapproved; do not add name, address or client IP automatically. The application's fallback includes more fields, so do not omit this allowlist when enabling matching. Each merchant must also enable enhanced matching on its destination. See [the Shopify account setup](SHOPIFY_APP_ACCOUNT_SETUP.md) for approval checks.

Caddy automatically obtains TLS for all three hosts. Root serves public pages; root /app and Shopify callback paths redirect to app.metrico.live preserving queries. App responses preserve Shopify iframe CSP from Next.js; do not add X-Frame-Options DENY. API proxy preserves MCP streaming and incoming headers without access logs containing OAuth query codes. HTTPS certificate validation needs real DNS and reachable ports.

## Capacity and database pools

The initial service memory limits total about 1.6 GiB before the OS/Docker and transient operations. A 2 GiB host is a constrained beta starting point, not a proven production capacity. Monitor memory/OOM and CPU; use more RAM when real sync/backfill load warrants it. Images build in GitHub, not on this host. The release script pauses the worker before backup/migration to reduce overlap; queues persist in PostgreSQL. Swap may prevent a transient kill but cannot replace capacity or meet performance targets.

DATABASE_POOL_MAX starts at 5 per API/worker. The worker also owns an advisory-lock pool of 4, so one API + one worker budgets 14 connections plus migration/backup/admin headroom. Check Supabase's actual connection limit using `npm run perf:pool-budget` with DATABASE_CONNECTION_LIMIT and reserve; do not assume a project tier's default. Transaction-pooler connections are unsuitable for the worker's session advisory locks; use session pooling/direct access. RLS hardening preserves owner/BYPASSRLS roles; a custom backend role needs suitable policies before migration.

## Release sequence

Before deployment, validate the actual backend/frontend env pair with `npm run release:check-config -- --backend-env /private/backend.env --frontend-env /private/frontend-build.env`, and run `npm run shopify:app-store:check` with your actual submission environment. The frontend env file is public build configuration for validation, not a source of provider secrets. Resolve startup/configuration failures before touching production.

Once host, credentials, images, DNS and backups are configured, run from deploy/:

```sh
chmod 700 .
chmod 600 backend.env backup.env release.env
# Preserve the known-good image configuration before editing it for subsequent releases.
# cp release.env previous.release.env   (do this BEFORE replacing old digests)
./release.sh
./check-health.sh
```

The script validates pinned image references and Compose configuration, pulls images, runs the built production-startup and encryption-key validators without network calls, pauses the worker, creates an encrypted public-schema backup, runs Prisma migrate deploy in the matching migration image, starts all runtime services with health waits and checks public HTTPS endpoints. Invalid configuration fails before stopping the worker or changing the schema; error output includes setting names only. Backups include application tables and Prisma history, not the entire Supabase managed auth/storage system. Migrations are deliberately additive and run once. Failed backup/migration exits without upgrading running application containers and attempts to restart the previous worker; investigate the failure before retrying.

This is a rolling **single-host** update with a short interruption, not a zero-downtime deployment. If post-upgrade health fails, use the rollback steps below and inspect deployment logs without copying secrets into chat. Run merchant smoke checks after container health: Shopify install/billing/pixel collection, provider auth/reporting/purchase ingestion, consent withdrawal, deletion/uninstall and MCP authorization. API readiness verifies PostgreSQL; it does not prove provider approvals, Redis health or attribution.

## Monitoring and recovery

Run `./check-health.sh` from a scheduled monitor and route failures through the monitoring system you choose. Docker restart:unless-stopped restarts exited processes but does not automatically restart a merely unhealthy container. Worker health checks detect stalled/continually failing polling tasks; inspect job status/queue backlog as well. Keep bounded Docker logs. Alert on service failures, OOM, disk pressure, stale syncs/deliveries, database capacity and cloud charges. Test the monitor rather than assuming the script alone provides alerts.

`./backup.sh` creates age-encrypted dumps. Schedule it and copy successful dumps to an independently accessible off-host location, with bounded retention. An encrypted dump remaining only on the same AWS disk is not disaster recovery. Keep the decryption key separately, preserve the token encryption key securely, and restore a dump into an isolated PostgreSQL database as a launch gate. Recover application data with pg_restore only after reviewing the target; never restore over production as a routine test.

For code rollback, keep the old `release.env` as `previous.release.env` before editing. Restore its image digests and use `docker compose --env-file release.env -f compose.prod.yaml up -d --wait --wait-timeout 300 api worker frontend proxy`. Do **not** rerun release.sh with old migrations and do not undo/delete Prisma migration history. Image rollback is safe only while the new schema remains compatible; destructive future migrations require a separate reviewed recovery plan. Preserve Caddy's certificate volumes; do not use compose down -v as a deployment step.

## Still done by the owner

Provisioning, DNS, a real monitored support mailbox, GitHub public variables/GHCR access, secrets, hosted Shopify plans, provider approvals, encrypted off-host backup destination and live acceptance tests are operator tasks. No AWS access keys are required to build these images. Infrastructure creation and GitHub environments/secrets setup are intentionally reserved for the requested deployment walkthrough.
