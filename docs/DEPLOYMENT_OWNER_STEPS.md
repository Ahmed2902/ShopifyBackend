# Metrico first production deployment — owner steps

Updated October 9, 2026. This walkthrough does not create resources, merge PRs, deploy, change DNS or migrate the live database. Ahmed performs account actions and merges. Follow these steps in order; stop on a failed check instead of continuing to the next phase.

## 1. Use the prepared hosting layout

This release uses one AWS Linux x86_64 host for Caddy HTTPS, the Next.js frontend, the API and the worker. Supabase stays external. Redis is an external HTTPS REST service; installing a local Redis container does not satisfy `REDIS_REST_URL`.

| Public origin | Service |
| --- | --- |
| `https://metrico.live` | Marketing and public policies |
| `https://app.metrico.live` | Embedded Shopify app |
| `https://api.metrico.live` | API, collector, provider callbacks, webhooks and MCP |

Do not deploy a second frontend on Vercel while following this layout. A Vercel frontend is possible with different routing/configuration, but Vercel Hobby is restricted to noncommercial personal use. Reference: https://vercel.com/docs/plans/hobby.

## 2. Prepare the account values before merging

Create or choose a real monitored support mailbox. Review policy drafts against the actual operator, support contact, hosting, retention and subprocessors before publishing. The scripts do not verify those claims or mailbox delivery.

| Item | Where to obtain it | Destination |
| --- | --- | --- |
| Shopify public client ID and secret | Existing Metrico app credentials | Backend; public ID also frontend |
| Shopify Partner organization ID, Partner App GID and Partner API token | Partner Dashboard; token with Manage apps for subscription reads | Backend only |
| Hosted pricing app handle and two subscription-item handles | Actual Shopify hosted pricing configuration | Backend only |
| Supabase session/direct connection and database password | Project Connect and database settings | Backend and separate backup settings |
| Redis REST URL and token | Existing Redis REST provider dashboard | Backend only |
| Meta App ID/secret | Existing Meta app | Backend only |
| TikTok App ID/secret | Existing Stride/Metrico API for Business app | Backend only |
| Google Ads OAuth Client ID/secret | The Cloud project with Explorer access | Backend only |
| Existing token-encryption key | Existing backend secret configuration | Backend only; preserve it |

Only the public Shopify client ID and support mailbox are needed for the first website-only stage. Other credentials can be prepared after the public pages are live. The full backend requires Shopify App Pricing configuration to start: installation, extension and billing tests can wait, but the backend cannot start with missing pricing settings. Configure Essentials USD 49.99 and Pro USD 84.99 every 30 days, eligible 14-day trials, and copy the actual handles. See [Shopify account setup](SHOPIFY_APP_ACCOUNT_SETUP.md). Do not make up handles or substitute the OAuth client ID for the Partner App GID.

Provider developer apps belong to Metrico. Advertiser accounts/pixels/conversion actions belong to merchants and are only needed now if you want a test merchant setup. No campaigns or advertising spend are required for deployment.

## 3. Add frontend GitHub repository variables

In **Ahmed2902/metrico-frontend → Settings → Secrets and variables → Actions → Variables → New repository variable**, enter the following. Use repository variables, not an unreferenced GitHub Environment.

| Variable | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | `https://api.metrico.live` |
| `NEXT_PUBLIC_SITE_URL` | `https://metrico.live` |
| `NEXT_PUBLIC_APP_URL` | `https://app.metrico.live` |
| `NEXT_PUBLIC_SHOPIFY_API_KEY` | Existing Shopify public client ID |
| `NEXT_PUBLIC_SUPPORT_EMAIL` | Your actual monitored mailbox |
| `NEXT_PUBLIC_ENABLE_TIKTOK` | `true` |
| `NEXT_PUBLIC_SHOPIFY_APP_STORE_URL` | Leave unset until the real listing is published |

The publishing workflow requires a client ID and support email. The three origins have these defaults, but setting them explicitly makes the deployment inspectable. Changing public variables requires rebuilding the frontend image; restarting a container does not change compiled public values.

Both repositories publish through the automatic `GITHUB_TOKEN`. Do not create that token yourself. No AWS keys, Shopify secrets, database password or advertising secret is needed in GitHub to build these images. Backend runtime secrets will be entered privately on the server. The workflows do not deploy to AWS, so a GitHub `production` Environment is not required for this manual release.

Check Actions is enabled. The publication job requests `packages: write` and `actions: read`; repository/organization policies must permit them. If permissions are blocked, resolve the actual policy rather than granting unrelated credentials. Reference: https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-variables.

## 4. Finish Sentry and merge its monitoring changes manually

Backend #156 and frontend #104 are already merged; their main CI and publication succeeded. The current image pins are recorded in step 5. Those images precede the Sentry changes.

Before merging the new monitoring PRs:

1. In your existing Sentry organization, create **metrico-backend** (Node.js / Express) and **metrico-frontend** (Next.js). Keep the existing SDK code; do not run the wizard over it.
2. Open each project's Settings → Client Keys (DSN), and copy its DSN privately.
3. Add the frontend project's DSN as GitHub repository **variable** `NEXT_PUBLIC_SENTRY_DSN` in `Ahmed2902/metrico-frontend`. A DSN is a public ingestion address, not an organization authentication token.
4. Review and manually merge [backend #157](https://github.com/Ahmed2902/ShopifyBackend/pull/157) and [frontend #105](https://github.com/Ahmed2902/metrico-frontend/pull/105) after latest-head checks pass. No Sentry account token is required for these builds. Source-map upload is disabled for this first deployment; frontend errors have bundled code locations rather than fully mapped original source.
5. Wait for successful **CI** and then **Publish containers** on each new main commit. Replace all three application image pins with the new publication summaries. Keep backend and migration images from the same backend commit. Setting a DSN cannot add monitoring code to an older image.

If the Sentry variable was added after frontend publication, dispatch **Publish containers** again on main, then use that new digest. Browser DSNs are compiled into the image. Server DSNs are configured in step 12/15.


## 5. Record the image references


Verified current images (before the Sentry PRs), for backend main `65640921cc97d46f30147160db4a1099752b8e9e` and frontend main `718eb30f9ddc9c894413ae88225096b2076c4a8f`:

```env
BACKEND_IMAGE=ghcr.io/ahmed2902/metrico-backend@sha256:0f439fb1ad2ae4e4f80b7f37c444dd6bf92612d51551d16399d04d3586737b1c
MIGRATION_IMAGE=ghcr.io/ahmed2902/metrico-migrations@sha256:280d05f1e7377e760f0d993d0f690023a54be7d5667e0f723e16363301e9c4a5
FRONTEND_IMAGE=ghcr.io/ahmed2902/metrico-frontend@sha256:34c88fda915bac6e850baee2dd2489733bf5b550c9709662623fa05c21de198b
```

Verified from [backend publication](https://github.com/Ahmed2902/ShopifyBackend/actions/runs/37890514171) and [frontend publication](https://github.com/Ahmed2902/metrico-frontend/actions/runs/37891275674). Use newer pins from the merged monitoring release to activate Sentry.

Open each repository's **Actions → Publish containers → successful run → Summary**. Copy the complete lines for:

```text
BACKEND_IMAGE=ghcr.io/ahmed2902/metrico-backend@sha256:...
MIGRATION_IMAGE=ghcr.io/ahmed2902/metrico-migrations@sha256:...
FRONTEND_IMAGE=ghcr.io/ahmed2902/metrico-frontend@sha256:...
```

Backend and migration images must come from the same final backend commit. The frontend comes from its own final commit. Record both commit SHAs privately in your release notes. Dots above indicate where GitHub supplies the real digest, not a value to paste.

If publication failed because public variables were missing, set them and manually run **Publish containers** on `main`. The workflow verifies successful main-push CI for the exact checked-out commit, including manual retries. It stops if CI is missing, pending, failed or unrelated.

## 6. Choose and create the AWS host

Recommended low-cost beta: **Lightsail → Create instance → Ireland (`eu-west-1`) → Linux/Unix → OS only → Ubuntu 24.04 LTS → public IPv4 bundle → 2 GB ($12/month)**. Choose **4 GB ($24/month)** for more host memory; the prepared container limits remain bounded until deliberately tuned. Verify the architecture with `uname -m` after connecting; it must be `x86_64`. These are current base bundle prices, before taxes, snapshots, overages and external services.

The 2 GB plan is a constrained beta starting point, not measured merchant capacity. It packages disk, transfer and IPv4 into one price and runs the prepared Compose layout without a separate load balancer. All four services share one host, so this first setup has one host failure point. Keep Supabase and Redis external.

In Lightsail:

1. Save/download the region's SSH private key securely on your computer, or select your existing key.
2. Create and **attach a static IPv4 address** to this instance. Use that address for all three DNS records.
3. Networking firewall: TCP 22 from your administrative public IP only; TCP 80 and 443 from the Internet. Do not open 3000, 3001, database ports or Docker.
4. Check AWS Billing → Credits for the actual expiry and eligible services of your $100 grant. Configure a small monthly cost budget and email alert. Credits do not stop charges automatically.

If you already created EC2, keep it: **Ubuntu 24.04 x86, `t3.small` (2 GB) or a larger x86 instance, 20+ GB encrypted gp3, stable Elastic IP**, with the same firewall rules. EC2 provides more networking/IAM choices; instance, disk and public IPv4 are billed separately. Review burst CPU credits and the regional total. This deployment does not need ECS/Fargate or a load balancer yet; reconsider those when measured load or availability requires multiple instances.

References: https://aws.amazon.com/lightsail/pricing/ and https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EC2_GetStarted.html.

## 7. Configure DNS

At the DNS provider for metrico.live, create/update these A records to the stable AWS IPv4 address:

| Type | Host | Value |
| --- | --- | --- |
| A | `@` | AWS stable IPv4 |
| A | `app` | Same IPv4 |
| A | `api` | Same IPv4 |

For this walkthrough use DNS-only routing initially so Caddy can obtain certificates directly. Remove conflicting old records for these hosts. Do not add an AAAA record unless the server's IPv6 routing and firewall are configured. Keep unrelated email verification/MX/TXT records.

Allow DNS to propagate. Caddy needs all three names to resolve correctly and ports 80/443 reachable. If CAA records restrict certificate issuers, ensure the issuer Caddy uses is allowed.

## 8. Connect from Windows

Use PowerShell/OpenSSH. Replace the example key path and address with your own:

```powershell
$MetricoKey = 'C:\Keys\metrico-production.pem'
$MetricoHost = 'YOUR_STABLE_AWS_IP'
ssh -i $MetricoKey "ubuntu@$MetricoHost"
```

Verify the server fingerprint through your AWS connection information when available. If SSH fails, check the selected key, username `ubuntu`, instance status and security-group source IP; changing networks may change your administrative IP.

## 9. Install the host tools

Run the following on the fresh Ubuntu server, following Docker's official apt-repository installation. Do not run it on your Windows machine.

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl age git
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc
sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo systemctl enable --now docker
sudo usermod -aG docker ubuntu
```

Docker-group membership grants administrative control. Disconnect and reconnect SSH to apply it, then run:

```bash
docker version
docker compose version
```

Compose must support raw env files (2.30+). Also keep OS security updates enabled. Reference: https://docs.docker.com/engine/install/ubuntu/.

## 10. Copy the reviewed deployment bundle

After merging, on your computer download the backend main source using **GitHub → Code → Download ZIP**, or update your existing checkout without discarding local work. Extract it. Copy the complete `deploy` directory to the server; do not copy your laptop's `.env` or node_modules.

On the server:

```bash
mkdir -p ~/metrico
chmod 700 ~/metrico
```

Back in Windows PowerShell, with the two variables from step 8 and the actual extracted path:

```powershell
scp -i $MetricoKey -r 'C:\YOUR_EXTRACTED_PATH\ShopifyBackend-main\deploy' "ubuntu@${MetricoHost}:metrico/"
```

Reconnect SSH and run:

```bash
cd ~/metrico/deploy
chmod 700 .
chmod +x public.sh release.sh backup.sh check-health.sh monitor.sh backup-monitored.sh
cp backend.env.example backend.env
cp backup.env.example backup.env
cp release.env.example release.env
cp frontend-build.env.example frontend-build.env
chmod 600 backend.env backup.env release.env frontend-build.env
```

These copies are for the **first** release only. Do not overwrite configured env files with templates during an update.

## 11. Configure registry access

For private GHCR packages, create an expiring GitHub **classic PAT with read:packages** for an account that can read these packages, with any organization SSO authorization required. It is used for server pulls, not provider authorization. Enter it without a command-line literal:

```bash
read -r -s -p 'GHCR read token: ' METRICO_GHCR_TOKEN
printf '\n'
printf '%s' "$METRICO_GHCR_TOKEN" | docker login ghcr.io -u Ahmed2902 --password-stdin
unset METRICO_GHCR_TOKEN
```

If packages are public, unauthenticated pulls are sufficient. Default Docker credential storage is local to the administrative account; protect it and use a credential helper where available. Reference: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry.

## 12. Fill release.env and validate the proxy

Paste the three exact application-image references from step 5 into `release.env`. Resolve and record the proxy digest:

```bash
docker pull caddy:2-alpine
docker image inspect caddy:2-alpine --format '{{index .RepoDigests 0}}'
```

Paste that complete `caddy@sha256:...` reference into `PROXY_IMAGE`. Set `FRONTEND_SENTRY_DSN` in `release.env` to the frontend Sentry project DSN for server-side error reporting; use the same project DSN as the public browser build variable. All four references must contain real digests. The release rejects placeholders and wrong repositories. Keep the proxy digest unchanged until deliberately updating it.

Validate the public-stage configuration and proxy:

```bash
docker compose --env-file release.env -f compose.public.yaml config --quiet
METRICO_PROXY_IMAGE=$(sed -n 's/^PROXY_IMAGE=//p' release.env)
docker run --rm -v "$PWD/Caddyfile.public:/etc/caddy/Caddyfile:ro" "$METRICO_PROXY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

The proxy validation only checks syntax. Backend and migration digests can remain unfilled for the public stage; both must be filled with a matching real pair before the full release.

## 13. Deploy the public website first

After DNS, frontend/proxy image references and registry access are ready, run on the server:

```bash
./public.sh
```

This starts only the frontend and HTTPS proxy and checks `/privacy`, `/terms`, `/data-deletion` and the public frontend health endpoint. No backend secrets, hosted plans, database access, backup or migrations are required for this stage.

The app and API domains deliberately return HTTP 503 until the full release. The public homepage/policies are available, but merchant authorization and Shopify installation are not ready. Finish the remaining account settings using these live policy links. Public bootstrap refuses to run if API/worker containers from a full release already exist, including stopped ones; it is not a rollback/update command.

## 14. Finish provider public configuration

| Provider | Production OAuth redirect |
| --- | --- |
| Meta | `https://api.metrico.live/v1/integrations/meta/callback` |
| TikTok | `https://api.metrico.live/v1/integrations/tiktok/callback` |
| Google Ads | `https://api.metrico.live/v1/integrations/google-ads/callback` |

Meta: enter the live privacy and deletion-instructions URLs, confirm public access, and finish permissions/business verification/app review as applicable. Initial reporting is separate from `ads_management` purchase-sharing consent.

Google: retain Explorer approval, verify metrico.live ownership, finish branding and the applicable `adwords`/`datamanager` OAuth verification, and publish the approved configuration before serving external merchants. Explorer approval does not replace OAuth verification.

TikTok: use the existing developer app, confirm advertiser/account-read permissions, pixel discovery and `event/track` authority. Reporting can work while `TIKTOK_EVENTS_API_ENABLED=false`. Enable that flag only after actual OAuth event authority is verified; it does not grant approval. Reauthorize after permission changes where needed.

Register the intended callback URLs now; their authorization flows become testable after the full backend release. Verification videos may also require that full working flow.

See [provider account setup](PROVIDER_ACCOUNT_SETUP.md). Do not paste the test pixel's browser snippet into the Metrico marketing website. Clients use their own destinations.

## 15. Configure hosted billing and fill backend.env privately

Now configure the existing app's actual hosted plans and Partner subscription-read access as described in [Shopify account setup](SHOPIFY_APP_ACCOUNT_SETUP.md). Copy the real app/plan handles into the file. This is account configuration; live Shopify store testing follows deployment.

Use `nano backend.env` on the server, or securely transfer a privately prepared file. The Compose raw format expects unquoted values: literal `$` and `#` are preserved. Never `source` the file or print it in terminal logs/chat. Preserve the production values already supplied in the template, then replace every `REPLACE_WITH_...` setting.

| Group | What to fill |
| --- | --- |
| Database | `DATABASE_URL`; optional `MIGRATION_DATABASE_URL` |
| Cache/rate limits | `REDIS_REST_URL`, `REDIS_REST_TOKEN` |
| Security | `JWT_ACCESS_SECRET`, existing `TOKEN_ENCRYPTION_KEY`, `SHOPIFY_STATE_SECRET`, `META_STATE_SECRET` |
| Shopify app | `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`; retain only actual justified/approved scopes |
| Billing | `SHOPIFY_PARTNER_ORG_ID`, `SHOPIFY_PARTNER_API_ACCESS_TOKEN`, `SHOPIFY_PARTNER_APP_ID`, `SHOPIFY_APP_HANDLE`, both plan handles |
| Contacts | `SHOPIFY_SUPPORT_EMAIL`, `SHOPIFY_REVIEW_CONTACT_EMAIL`, `SHOPIFY_EMERGENCY_CONTACT_EMAIL` |
| Meta | Existing `META_APP_ID`, `META_APP_SECRET`; initial `META_SCOPES=ads_read` |
| TikTok | Uncomment `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`, `TIKTOK_STATE_SECRET`; existing App ID is `7683136035535863828` |
| Sentry | Add backend project `SENTRY_DSN`, set `SENTRY_RELEASE=backend-<actual image commit SHA>`; leave `SENTRY_WORKER_MONITOR_SLUG` unset for the one-cron-monitor setup |
| Google Ads | Uncomment `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_STATE_SECRET`; retain API `v25` |

Generate a separate fresh secret for each state/auth setting on your own machine or server with `openssl rand -hex 32`; do not reuse one across providers. Enter outputs directly into the appropriate private file. For a genuinely new database with no encrypted records, `openssl rand -base64 32` can create the token-encryption key; otherwise retain the existing key. Randomly replacing that key makes stored provider tokens unreadable.

Keep `LEGACY_MERCHANT_AUTH_ENABLED=false`, `SHOPIFY_APP_PRICING_ENABLED=true`, `SHOPIFY_ENHANCED_MATCHING_APPROVED=false` and `TIKTOK_EVENTS_API_ENABLED=false` initially. Keep an explicit approved-field allowlist for matching; the template uses `email,phone,customer_id`, with matching still disabled. Do not set `GOOGLE_ADS_DEVELOPER_TOKEN`. Do not carry local callback overrides into production.

The template's app origin is `https://app.metrico.live`, API origin is `https://api.metrico.live`, Shopify callback is `https://app.metrico.live/api/shopify/callback`, and collector is `https://api.metrico.live/v1/pixel/events`.

## 16. Choose the database connections and backup credentials

In Supabase **Connect**, obtain a direct connection if reachable, or the **session pooler** connection appropriate to this project. This worker uses session advisory locks: do not use transaction pooling. Include TLS configuration in the database URL and percent-encode the password if it contains URL-special characters. Do not confuse the Supabase API URL/key with a PostgreSQL connection.

Use the actual host, port and username shown by Supabase rather than guessing a project-specific hostname. If direct connectivity is IPv6-only and the AWS host does not have IPv6, session pooling provides an alternative. See https://supabase.com/docs/guides/database/connecting-to-postgres.

`DATABASE_POOL_MAX=5` gives 14 planned application connections for one API and one worker, including the worker's separate advisory-lock pool. Reserve capacity for migrations, backups and administration against the real project's limit. If using a custom DB role, verify its required access after the prepared RLS/grant migrations; browser roles are not backend roles.

Fill `backup.env` with the separate `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` components and TLS settings. The password is a literal component here, not a URL-encoded password. The prepared backup client is PostgreSQL 17; verify it is compatible with the server version. Do not reset the database password merely to deploy if it is already in use elsewhere.

On your computer, mirror GitHub's public variables into the copied `frontend-build.env` and use the backend repo's existing Node 22 setup to run:

```bash
npm run release:check-config -- --backend-env /YOUR_PRIVATE_PATH/backend.env --frontend-env /YOUR_PRIVATE_PATH/frontend-build.env
```

Use actual private paths appropriate to your OS. This command checks matching public configuration without printing values. It does not contact the database or prove account approvals. The server release also runs the built startup validator before stopping the worker or applying migrations.

## 17. Prepare backup encryption

Generate an age identity on **your computer** using age, and keep the private identity off the server. On Windows, download the Windows amd64 archive from https://github.com/FiloSottile/age/releases, extract it, and run `age-keygen.exe -o metrico-backup-identity.txt` from that directory. On Linux/macOS with age installed, use `age-keygen -o metrico-backup-identity.txt`. It prints its public recipient. Copy only that `age1...` public recipient into the server's `backup.recipient`. Keep the private identity securely backed up; a recipient alone cannot decrypt a dump.

Choose an off-host destination for encrypted backups, retention and alerts. A dump on the same AWS disk is not disaster recovery. The prepared dump covers the public application schema and Prisma history, not the full managed Supabase auth/storage system.

## 18. Run the first full release

After backend settings, real backend/migration image references and backup credentials are ready, validate Compose and create a backup:

```bash
docker compose --env-file release.env -f compose.prod.yaml --profile migration --profile backup config --quiet
./backup.sh
```

Copy the encrypted backup off-host and prove decryption/restore into an isolated PostgreSQL database, never production. Keep the private age identity off the server. Then run:

```bash
./release.sh
./check-health.sh
```

The full release preserves the public-stage project names and certificate volumes and replaces the temporary app/API responses with real routing. The release validates image references, pulls images, validates production startup settings without network calls, pauses the worker, creates an encrypted backup, runs migrations once, starts services and checks public HTTPS. Stop if either script fails; inspect the specific failed phase. Do not reset migration history or rerun destructive commands to force success.

Confirm the public homepage, `/privacy`, `/terms`, `/data-deletion`, and both `/api/health` frontend endpoints work. Confirm API readiness at `https://api.metrico.live/health/ready`. Health is deployment evidence, not proof of end-to-end OAuth, billing, consent, attribution or provider approval. API readiness exercises configured database/cache dependencies; merchant paths still need acceptance testing.


### Activate and verify Sentry before merchant testing

1. On the server, send a backend smoke event from the running API container:

   ```bash
   docker compose --env-file release.env -f compose.prod.yaml exec -T api node scripts/check-sentry.mjs
   ```

   Confirm an issue appears in **metrico-backend** with environment `production` and tag `service=api`. A flushed SDK queue alone is not proof that Sentry received it. Raw messages are intentionally replaced with a generic message; code locations remain for grouping.
2. In a browser on the deployed app, open DevTools Console and run `setTimeout(() => { throw new Error('Metrico frontend monitoring check'); }, 0)`. Confirm a new issue in **metrico-frontend**. This is a temporary client-side check, not a public server crash endpoint. Browser blocking extensions can prevent telemetry.
3. In Sentry **Monitors → Create Monitor → Uptime**, create **Metrico API readiness**, GET `https://api.metrico.live/health/ready`, 1-minute interval, 10-second timeout, 3 consecutive failures, 1 recovery. No auth headers or payloads. This is the external check that still runs if the whole host is offline.
4. Run `./monitor.sh` once after a successful backup. It creates/upserts **metrico-host**, interval 5 minutes, 2-minute margin, UTC. It checks all four services and the three HTTPS health endpoints, disk at 80%, any container at 90% of its memory limit, and an encrypted local backup newer than 36 hours. Missing host check-ins are visible externally. Confirm the monitor's successful check-in in Sentry.
5. In **Alerts**, configure delivery to your verified email/team for new/unhandled production errors and regression, cron failures/missed check-ins, and uptime downtime. Select the intended projects/monitor sources. Monitor creation alone does not prove email delivery; use Sentry's alert test and confirm receipt. Review a Sentry event's payload to verify no customer/request/provider details are present.
6. Install the following in the `ubuntu` user's `crontab -e`. The first command should succeed manually before scheduling it. Server paths below assume the walkthrough's `~/metrico/deploy` location; confirm your server user's home directory. Backups run at 03:00 UTC (`CRON_TZ=UTC`).

   ```cron
   CRON_TZ=UTC
   */5 * * * * cd /home/ubuntu/metrico/deploy && ./monitor.sh >/dev/null 2>&1
   0 3 * * * cd /home/ubuntu/metrico/deploy && ./backup-monitored.sh >/dev/null 2>&1
   ```

   `backup-monitored.sh` records success/failure and reuses the same host monitor. It does not transfer dumps off-host. Configure that transfer and bounded retention separately, and verify an isolated restore. The freshness check proves dump creation only, not recoverability or off-host copying.
7. Before onboarding merchants, test alerts during a short maintenance window: stop the worker, let Docker mark it unhealthy and let the next host check run, confirm the Sentry notification, then start the worker and verify recovery. Test external uptime and missed checks on a staging setup rather than disrupting production merchants.

All Sentry plans currently include **one cron monitor and one uptime monitor**. This default uses exactly those two. If the account already uses its included monitors, reuse/replace only intentionally or review its quota. Additional monitors require a paid plan and PAYG budget. The optional dedicated worker heartbeat is enabled only by setting `SENTRY_WORKER_MONITOR_SLUG=metrico-worker`; leave it unset for this default. Three separate uptime URLs or a separate worker monitor would consume additional quota.

Replay, performance tracing, log forwarding, metrics forwarding, and source-map upload are disabled. Browser IP/request network metadata can still be processed by Sentry's ingestion infrastructure; inspect project privacy/retention settings. Sentry is not a replacement for AWS billing budgets, database capacity review or off-host backup recovery.

References: https://docs.sentry.io/product/monitors-and-alerts/monitors/uptime-monitoring/ and https://docs.sentry.io/pricing/quotas/manage-cron-monitors/.

## 19. Release Shopify configuration and test a store

Once production endpoints exist, update the **existing** linked Shopify app with these public values. Use `npm run shopify:app-config` in a privately configured backend checkout, validate the generated config with the current Shopify CLI, review it, then deploy the linked app version and updated pixel/theme extensions using their existing UIDs. Backend migrations must precede extension activation. See [Shopify account setup](SHOPIFY_APP_ACCOUNT_SETUP.md); do not create a substitute custom-store app.

Test installation/reopening inside Shopify and Chrome incognito; hosted-plan approval/decline, trial eligibility, plan change/cancellation; commerce sync; and the actual selected ad accounts. The first verified install bootstrap can invalidate old provider destinations and MCP grants, so reconnect after it if necessary.

For optional email/phone/customer-ID matching, verify actual protected-data approval and marketing purpose, retain the explicit approved-field allowlist, then enable the deployment flag and the merchant's destination setting. Do not treat requested approval as granted.

## 20. Complete live acceptance and launch

| Check | Required evidence |
| --- | --- |
| Reporting | Real authorized accounts; correct dates, currencies, timezone and available history |
| Shopify commerce | Products, orders, refunds, inventory, backfill and product/ad mappings |
| Purchase sharing | Correct merchant destination; eligible consented purchase; provider receipt and no duplicate event |
| Funnel/browser signals | Released extensions; consented view/cart/checkout events; denied and withdrawn consent |
| Enhanced matching | Actual approvals; approved fields only; permitted destination configuration |
| Privacy/lifecycle | Export, redaction, uninstall/reinstall and cleanup |
| MCP | GPT/Claude authorization, permitted read tools, store isolation and disconnect |
| Performance | Embedded app, mobile navigation, storefront impact and realistic sync load |

The current purchase smoke requires an eligible order that is not marked as a Shopify test/cancelled order. Do not assume a bogus-gateway test order validates production purchase delivery. Provider acceptance does not guarantee attribution to an ad.

Fix failed checks and repeat the affected path. Configure actual alerts for health, worker backlog, stale syncs/delivery, disk/memory/database pressure and costs. Schedule backups, transfer them off-host, verify restore and keep bounded retention. Running a health script without an alert destination does not create monitoring.

Finish the prepared Shopify listing copy/media, reviewer-safe account access and English screencast, run the final submission checklist, submit and address review feedback. Add the real listing URL to the frontend variables and rebuild when published. Onboard initial merchants only with the capabilities that passed validation.

## Updates and rollback

Before replacing release digests, preserve the previous configuration:

```bash
cp release.env previous.release.env
```

After reviewing/merging a later release, wait for main CI/publication, use the new paired digests and repeat validation/backup/release/acceptance. A rollback uses the old image configuration without rerunning old migration images:

```bash
docker compose --env-file previous.release.env -f compose.prod.yaml up -d --wait --wait-timeout 300 api worker frontend proxy
```

Image rollback does not undo database migrations and is safe only when the schema remains compatible. Keep previous images accessible. Preserve Caddy certificate volumes and production secret files; do not use `docker compose down -v` as an update step.
