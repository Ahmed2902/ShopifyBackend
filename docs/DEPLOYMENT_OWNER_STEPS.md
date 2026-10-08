# Metrico first production deployment — owner steps

Prepared October 8, 2026. This walkthrough does not create resources, merge PRs, deploy, change DNS or migrate the live database. Ahmed performs account actions and merges. Follow these steps in order; stop on a failed check instead of continuing to the next phase.

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

The live backend requires Shopify App Pricing configuration to start. Shopify installation, extension and billing tests can wait until after deployment, but production cannot start with missing pricing settings. Configure Essentials USD 49.99 and Pro USD 84.99 every 30 days, eligible 14-day trials, and copy the actual handles. See [Shopify account setup](SHOPIFY_APP_ACCOUNT_SETUP.md). Do not make up handles or substitute the OAuth client ID for the Partner App GID.

Provider developer apps belong to Metrico. Advertiser accounts/pixels/conversion actions belong to merchants and are only needed now if you want a test merchant setup. No campaigns or advertising spend are required for deployment.

## 3. Add frontend GitHub repository variables

In **Ahmed2902/ShopifyFrontend → Settings → Secrets and variables → Actions → Variables → New repository variable**, enter the following. Use repository variables, not an unreferenced GitHub Environment.

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

## 4. Merge the existing PRs manually

1. Check latest-head CI and review threads on backend [#154](https://github.com/Ahmed2902/ShopifyBackend/pull/154).
2. Merge #154 into main.
3. Edit backend [#155](https://github.com/Ahmed2902/ShopifyBackend/pull/155), change its base to `main`, and inspect the resulting diff. Resolve any merge/base CI issue before merging. #155 is stacked on #154.
4. Merge #155 after its current checks pass.
5. Merge frontend [#103](https://github.com/Ahmed2902/ShopifyFrontend/pull/103) after its current checks pass and the variables above are configured.

Wait for **CI** on the final main commits in both repositories. After successful push CI, **Publish containers** runs automatically. Do not deploy images from an earlier backend main commit that preceded #155.

## 5. Record the image references

Open each repository's **Actions → Publish containers → successful run → Summary**. Copy the complete lines for:

```text
BACKEND_IMAGE=ghcr.io/ahmed2902/metrico-backend@sha256:...
MIGRATION_IMAGE=ghcr.io/ahmed2902/metrico-migrations@sha256:...
FRONTEND_IMAGE=ghcr.io/ahmed2902/metrico-frontend@sha256:...
```

Backend and migration images must come from the same final backend commit. The frontend comes from its own final commit. Record both commit SHAs privately in your release notes. Dots above indicate where GitHub supplies the real digest, not a value to paste.

If publication failed because public variables were missing, set them and manually run **Publish containers** on `main`. The workflow verifies successful main-push CI for the exact checked-out commit, including manual retries. It stops if CI is missing, pending, failed or unrelated.

## 6. Create the AWS host

In AWS, check credit eligibility and the displayed estimate for compute, disk and public IPv4 before launching. Configure a budget alert to your monitored inbox. This guide intentionally does not assume current prices or that every service is covered by your credits.

Use **EC2 → Instances → Launch instance**:

| Field | Initial configuration |
| --- | --- |
| Name | `metrico-production` |
| Region | Prefer close to the existing Supabase project; the earlier release plan used Ireland `eu-west-1` |
| OS | Ubuntu Server 24.04 LTS, **64-bit x86** |
| Instance | A 2 GiB x86 instance such as `t3.small` for a constrained beta; inspect the price and monitor real load |
| CPU credits | Review burst-credit billing; Standard avoids surplus-credit charges at the cost of throttling after credits run out |
| Key pair | Create/select your SSH key; save the private key securely on your computer |
| Root disk | 20 GiB encrypted gp3 initially; monitor image/log/backup disk use |
| Network | Public subnet with Internet access; associate a stable public address |
| Security group | TCP 22 from **your administrative public IP only**; TCP 80/443 from the Internet |

Do not choose an ARM/Graviton instance: the current release images target `linux/amd64`. A 2 GiB machine is a beta starting point, not measured production capacity. Increase memory if sync/backfill load requires it. Do not expose API 3001, frontend 3000, PostgreSQL or the Docker socket.

Associate an Elastic IP with this instance if using EC2 so a stop/start does not require changing DNS. A public address can have a separate charge. Keep a record of the address and key path; the private key is never a GitHub repository file or chat attachment.

Reference: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/EC2_GetStarted.html.

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
chmod +x release.sh backup.sh check-health.sh
cp backend.env.example backend.env
cp backup.env.example backup.env
cp release.env.example release.env
cp frontend-build.env.example frontend-build.env
chmod 600 backend.env backup.env release.env frontend-build.env
```

These copies are for the **first** release only. Do not overwrite configured env files with templates during an update.

## 11. Fill backend.env privately

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
| Google Ads | Uncomment `GOOGLE_ADS_CLIENT_ID`, `GOOGLE_ADS_CLIENT_SECRET`, `GOOGLE_ADS_STATE_SECRET`; retain API `v25` |

Generate a separate fresh secret for each state/auth setting on your own machine or server with `openssl rand -hex 32`; do not reuse one across providers. Enter outputs directly into the appropriate private file. For a genuinely new database with no encrypted records, `openssl rand -base64 32` can create the token-encryption key; otherwise retain the existing key. Randomly replacing that key makes stored provider tokens unreadable.

Keep `LEGACY_MERCHANT_AUTH_ENABLED=false`, `SHOPIFY_APP_PRICING_ENABLED=true`, `SHOPIFY_ENHANCED_MATCHING_APPROVED=false` and `TIKTOK_EVENTS_API_ENABLED=false` initially. Keep an explicit approved-field allowlist for matching; the template uses `email,phone,customer_id`, with matching still disabled. Do not set `GOOGLE_ADS_DEVELOPER_TOKEN`. Do not carry local callback overrides into production.

The template's app origin is `https://app.metrico.live`, API origin is `https://api.metrico.live`, Shopify callback is `https://app.metrico.live/api/shopify/callback`, and collector is `https://api.metrico.live/v1/pixel/events`.

## 12. Choose the database connections and backup credentials

In Supabase **Connect**, obtain a direct connection if reachable, or the **session pooler** connection appropriate to this project. This worker uses session advisory locks: do not use transaction pooling. Include TLS configuration in the database URL and percent-encode the password if it contains URL-special characters. Do not confuse the Supabase API URL/key with a PostgreSQL connection.

Use the actual host, port and username shown by Supabase rather than guessing a project-specific hostname. If direct connectivity is IPv6-only and the AWS host does not have IPv6, session pooling provides an alternative. See https://supabase.com/docs/guides/database/connecting-to-postgres.

`DATABASE_POOL_MAX=5` gives 14 planned application connections for one API and one worker, including the worker's separate advisory-lock pool. Reserve capacity for migrations, backups and administration against the real project's limit. If using a custom DB role, verify its required access after the prepared RLS/grant migrations; browser roles are not backend roles.

Fill `backup.env` with the separate `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD` components and TLS settings. The password is a literal component here, not a URL-encoded password. The prepared backup client is PostgreSQL 17; verify it is compatible with the server version. Do not reset the database password merely to deploy if it is already in use elsewhere.

On your computer, mirror GitHub's public variables into the copied `frontend-build.env` and use the backend repo's existing Node 22 setup to run:

```bash
npm run release:check-config -- --backend-env /YOUR_PRIVATE_PATH/backend.env --frontend-env /YOUR_PRIVATE_PATH/frontend-build.env
```

Use actual private paths appropriate to your OS. This command checks matching public configuration without printing values. It does not contact the database or prove account approvals. The server release also runs the built startup validator before stopping the worker or applying migrations.

## 13. Prepare backup encryption and registry access

Generate an age identity on **your computer** using age, and keep the private identity off the server. On Windows, download the Windows amd64 archive from https://github.com/FiloSottile/age/releases, extract it, and run `age-keygen.exe -o metrico-backup-identity.txt` from that directory. On Linux/macOS with age installed, use `age-keygen -o metrico-backup-identity.txt`. It prints its public recipient. Copy only that `age1...` public recipient into the server's `backup.recipient`. Keep the private identity securely backed up; a recipient alone cannot decrypt a dump.

Choose an off-host destination for encrypted backups, retention and alerts. A dump on the same AWS disk is not disaster recovery. The prepared dump covers the public application schema and Prisma history, not the full managed Supabase auth/storage system.

For private GHCR packages, create an expiring GitHub **classic PAT with read:packages** for an account that can read these packages, with any organization SSO authorization required. It is used for server pulls, not provider authorization. Enter it without a command-line literal:

```bash
read -r -s -p 'GHCR read token: ' METRICO_GHCR_TOKEN
printf '\n'
printf '%s' "$METRICO_GHCR_TOKEN" | docker login ghcr.io -u Ahmed2902 --password-stdin
unset METRICO_GHCR_TOKEN
```

If packages are public, unauthenticated pulls are sufficient. Default Docker credential storage is local to the administrative account; protect it and use a credential helper where available. Reference: https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry.

## 14. Fill release.env and validate the proxy

Paste the three exact application-image references from step 5 into `release.env`. Resolve and record the proxy digest:

```bash
docker pull caddy:2-alpine
docker image inspect caddy:2-alpine --format '{{index .RepoDigests 0}}'
```

Paste that complete `caddy@sha256:...` reference into `PROXY_IMAGE`. All four references must contain real digests. The release rejects placeholders and wrong repositories. Keep the proxy digest unchanged until deliberately updating it.

Validate the configuration and create the first backup:

```bash
docker compose --env-file release.env -f compose.prod.yaml --profile migration --profile backup config --quiet
METRICO_PROXY_IMAGE=$(sed -n 's/^PROXY_IMAGE=//p' release.env)
docker run --rm -v "$PWD/Caddyfile:/etc/caddy/Caddyfile:ro" "$METRICO_PROXY_IMAGE" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
./backup.sh
```

The proxy validation only checks syntax. Copy the resulting encrypted backup off-host and prove it decrypts/restores into an isolated PostgreSQL database; never use production as a restore-test target. The server has no decryption key by design. See [the release runbook](AWS_CONTAINER_RELEASE.md) for scope and recovery.

## 15. Run the first full release

After DNS, backup credentials, startup settings and image access are correct:

```bash
./release.sh
./check-health.sh
```

The release validates image references, pulls images, validates production startup settings without network calls, pauses the worker, creates an encrypted backup, runs migrations once, starts services and checks public HTTPS. Stop if either script fails; inspect the specific failed phase. Do not reset migration history or rerun destructive commands to force success.

Confirm the public homepage, `/privacy`, `/terms`, `/data-deletion`, and both `/api/health` frontend endpoints work. Confirm API readiness at `https://api.metrico.live/health/ready`. Health is deployment evidence, not proof of OAuth, Redis, billing, consent, attribution or provider approval.

## 16. Finish Meta, Google and TikTok public configuration

| Provider | Production OAuth redirect |
| --- | --- |
| Meta | `https://api.metrico.live/v1/integrations/meta/callback` |
| TikTok | `https://api.metrico.live/v1/integrations/tiktok/callback` |
| Google Ads | `https://api.metrico.live/v1/integrations/google-ads/callback` |

Meta: enter the live privacy and deletion-instructions URLs, confirm public access, and finish permissions/business verification/app review as applicable. Initial reporting is separate from `ads_management` purchase-sharing consent.

Google: retain Explorer approval, verify metrico.live ownership, finish branding and the applicable `adwords`/`datamanager` OAuth verification, and publish the approved configuration before serving external merchants. Explorer approval does not replace OAuth verification.

TikTok: use the existing developer app, confirm advertiser/account-read permissions, pixel discovery and `event/track` authority. Reporting can work while `TIKTOK_EVENTS_API_ENABLED=false`. Enable that flag only after actual OAuth event authority is verified; it does not grant approval. Reauthorize after permission changes where needed.

See [provider account setup](PROVIDER_ACCOUNT_SETUP.md). Do not paste the test pixel's browser snippet into the Metrico marketing website. Clients use their own destinations.

## 17. Release Shopify configuration and test a store

Once production endpoints exist, update the **existing** linked Shopify app with these public values. Use `npm run shopify:app-config` in a privately configured backend checkout, validate the generated config with the current Shopify CLI, review it, then deploy the linked app version and updated pixel/theme extensions using their existing UIDs. Backend migrations must precede extension activation. See [Shopify account setup](SHOPIFY_APP_ACCOUNT_SETUP.md); do not create a substitute custom-store app.

Test installation/reopening inside Shopify and Chrome incognito; hosted-plan approval/decline, trial eligibility, plan change/cancellation; commerce sync; and the actual selected ad accounts. The first verified install bootstrap can invalidate old provider destinations and MCP grants, so reconnect after it if necessary.

For optional email/phone/customer-ID matching, verify actual protected-data approval and marketing purpose, retain the explicit approved-field allowlist, then enable the deployment flag and the merchant's destination setting. Do not treat requested approval as granted.

## 18. Complete live acceptance and launch

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
