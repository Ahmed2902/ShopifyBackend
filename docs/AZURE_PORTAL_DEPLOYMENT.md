# Metrico: finish the Azure deployment in the portal

Updated October 10, 2026. This is the Azure walkthrough; the VM/Compose walkthrough in `DEPLOYMENT_OWNER_STEPS.md` uses a different layout. Keep the completed resource group, Container Apps environment and frontend. The remaining deployment has **two running Container Apps**: frontend and combined backend. Supabase and Redis REST remain external. No migration job or separate worker app is required.

## 1. Select the correct backend image

After the backend's main **CI** and **Publish containers** succeed, use the exact `AZURE_BACKEND_TAG` from the publication summary. Its format is:

```text
ghcr.io/ahmed2902/metrico-backend:azure-sha-<full-main-commit>
```

In Azure's image form enter **Registry** `ghcr.io` separately and **Image and tag** `ahmed2902/metrico-backend:azure-sha-<full-main-commit>`. Select a private registry, username `Ahmed2902` and the existing classic GitHub PAT with `read:packages`. Do not paste a digest into a portal field that requires a tag. Do not use the plain `sha-…` tag for this layout: that target starts only the API.

Leave **Command override** and **Arguments override** empty. The image validates production settings, runs `prisma migrate deploy`, then starts the API and all polling workers. A failed phase stops startup. On restart Prisma skips migrations already applied; it does not reset the database. The repository still publishes a separate migration image for other hosting layouts, but Azure does not use it here.

## 2. Create or update the backend Container App

In **Azure portal → Container Apps** create `metrico-backend`, or open that app if already created.

| Setting                      | Value                                                                 |
| ---------------------------- | --------------------------------------------------------------------- |
| Resource group / environment | Your existing Metrico production group and Container Apps environment |
| Deployment source            | Container image                                                       |
| Container name               | `backend`                                                             |
| Image                        | The verified Azure tag from step 1                                    |
| CPU / memory                 | 0.5 vCPU / 1 GiB                                                      |
| Revision mode                | Single                                                                |
| Minimum / maximum replicas   | 1 / 1                                                                 |
| Ingress                      | Enabled; accept traffic from anywhere                                 |
| Ingress type / transport     | HTTP / Auto                                                           |
| Target port                  | `3001`                                                                |
| Insecure HTTP                | Disabled                                                              |
| Command / arguments          | Empty                                                                 |

For an existing app, use **Application → Containers → Edit and deploy**, and **Application → Scale** for replica limits. Do not add HTTP autoscaling above one replica: every backend replica also runs the workers. An Azure revision replacement can briefly overlap old and new instances; Prisma's migration lock protects migrations, not all application work. Keep schema changes compatible with the preceding application revision. A destructive schema change needs a separate maintenance procedure.

## 3. Enter backend settings privately

Use [deploy/backend.env.example](../deploy/backend.env.example) as the complete settings checklist. Enter real values in Azure's **Environment variables** table, not the literal `REPLACE_WITH_…` text. Add passwords, connection URLs, client secrets and tokens under **Secrets** and select **Secret reference** in the environment-variable table. An optional value should be omitted entirely if unused.

The essential origin and monitoring settings are:

| Variable                     | Value                                           |
| ---------------------------- | ----------------------------------------------- |
| `NODE_ENV`                   | `production`                                    |
| `PORT`                       | `3001`                                          |
| `APP_URL`                    | `https://api.metrico.live`                      |
| `FRONTEND_URL`               | `https://app.metrico.live`                      |
| `CORS_ORIGIN`                | `https://app.metrico.live`                      |
| `SHOPIFY_REDIRECT_URI`       | `https://app.metrico.live/api/shopify/callback` |
| `SHOPIFY_APP_URL`            | `https://app.metrico.live/app/overview`         |
| `PIXEL_COLLECTOR_URL`        | `https://api.metrico.live/v1/pixel/events`      |
| `SENTRY_DSN`                 | Backend project's DSN, as a secret reference    |
| `SENTRY_SERVICE`             | `combined`                                      |
| `SENTRY_RELEASE`             | `backend-<full-main-commit>`                    |
| `SENTRY_WORKER_MONITOR_SLUG` | `metrico-worker`                                |

`DATABASE_URL` must be the real Supabase PostgreSQL connection with TLS. Use a reachable **session pooler** connection for this first deployment, not transaction pooling. If you use a separate `MIGRATION_DATABASE_URL`, it must also be a reachable direct/session connection with migration permissions. Otherwise migrations use `DATABASE_URL`. Preserve the existing `TOKEN_ENCRYPTION_KEY`; replacing it makes existing encrypted integration tokens unreadable.

Supply the real Redis **HTTPS REST** URL and token, JWT/state secrets, Shopify client credentials and the complete Shopify hosted-pricing group from the template. Hosted pricing must be configured for startup; installing/testing the app can wait. Enable TikTok/Google Ads by filling each provider's complete credential group. Keep `TIKTOK_EVENTS_API_ENABLED=false` until Events API access and merchant authorization are ready. Keep enhanced matching disabled until its required approval and consent controls are ready.

If using email signup/password reset, also set `RESEND_API_KEY`, `RESEND_FROM`, `EMAIL_VERIFICATION_URL=https://app.metrico.live/auth/verify-email` and `PASSWORD_RESET_URL=https://app.metrico.live/auth/reset-password`. Google account login has its own `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI=https://api.metrico.live/v1/auth/google/callback` and `GOOGLE_FRONTEND_REDIRECT_URI=https://app.metrico.live/auth/callback`; these differ from Google Ads credentials.

## 4. Add probes and deploy

In **Containers → Edit and deploy → Health probes**, add HTTP probes on port `3001`:

| Probe     | Path            | Interval   | Timeout   | Failure threshold |
| --------- | --------------- | ---------- | --------- | ----------------- |
| Startup   | `/health/live`  | 10 seconds | 5 seconds | 60                |
| Liveness  | `/health/live`  | 30 seconds | 5 seconds | 3                 |
| Readiness | `/health/ready` | 30 seconds | 5 seconds | 3                 |

This allows up to ten minutes for initial migrations. Docker's HEALTHCHECK is not a replacement for Azure's configured probes. Deploy the revision. Open **Monitoring → Log stream** and look for these phases in order: validate configuration, apply pending migrations, start API and workers. Inspect the named setting if configuration validation fails. If migration fails, fix the connection or actual migration error before retrying; do not use database reset or mark an unapplied migration as successful.

Open the backend's generated Application URL with `/health/live` and `/health/ready`; both must return HTTP 200. Readiness checks the database and the combined workers; liveness checks that the HTTP process responds.

## 5. Bind the two remaining certificates

In your DNS provider, point `api` with a **CNAME** directly to the backend's generated `…azurecontainerapps.io` hostname. Add the **TXT** record `asuid.api` using the backend's custom-domain verification value shown by Azure.

In **metrico-backend → Custom domains → Add custom domain**, enter `api.metrico.live`, validate the records, create/select the free managed certificate and bind it. Keep ingress public during validation.

For `app.metrico.live`, use the **frontend** Container App. Set CNAME `app` directly to its generated Azure hostname and TXT `asuid.app` to that frontend's verification value. In its **Custom domains** page select `app.metrico.live` and add the managed certificate binding. The existing `metrico.live` certificate does not cover `app.metrico.live`. If the binding panel does not offer issuance, check validation and the direct CNAME first; do not choose the backend app for this hostname.

`metrico.live` and `app.metrico.live` both use the same frontend container. The app subdomain is the embedded-app address already compiled into this frontend; it does not mean a third running container.

Check in a browser:

- `https://metrico.live`
- `https://app.metrico.live`
- `https://api.metrico.live/health/live`
- `https://api.metrico.live/health/ready`

## 6. Verify the frontend connects to the backend

Keep the existing frontend image `ahmed2902/metrico-frontend:sha-b43088c65aa6aa45fb2ec1bcaf68fc71ab7116b9`, including the Sentry rebuild. No frontend rebuild is needed for this backend change. Its runtime API origin must be `https://api.metrico.live`, matching the compiled public API origin. Enter its own project's `SENTRY_DSN` as a runtime secret reference for server errors.

Open signup/login and then the app in a browser. Confirm API requests reach `api.metrico.live` without a certificate error or CORS failure. Account creation must also complete email delivery/verification if using that flow. Public policy/support pages must show the actual business details.

## 7. Finish Sentry monitoring

In Sentry create/select a backend **Cron Monitor** with slug `metrico-worker`, interval **5 minutes**, check-in margin **2 minutes**, UTC. The combined backend sends healthy/error check-ins automatically. Wait for the first check-in; this is not evidence of a real merchant event delivery.

Create/select an **Uptime Monitor** for `https://api.metrico.live/health/ready` and configure your notification destination. This covers database/worker readiness as well as public HTTPS. The backend and frontend projects should receive their corresponding application errors. Existing SDK filtering removes request/merchant data; source-map upload remains disabled for this initial release.

## 8. Finish provider URLs and end-to-end acceptance

Once HTTPS works, finish Meta's privacy/deletion URLs, then align Shopify, TikTok and Google redirect/webhook URLs with the deployed URLs in the backend settings. Do not use a tracking pixel from Metrico's own advertiser account as a universal merchant pixel.

Test one development merchant: install/login, consent, initial Shopify sync, dashboard data, provider authorization, an order, consent-aware event delivery and retry behavior. Confirm the Events/Conversions destination dashboards show the expected test event once, with matching event/order IDs where applicable. Keep production merchant onboarding closed until these checks pass. Check Shopify uninstall and mandatory data-deletion webhooks before distribution.

This walkthrough adds no paid database-backup resource. Supabase stays on the current plan. Revisit backups and restore testing before relying on the service for paying merchants.
