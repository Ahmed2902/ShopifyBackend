# Metrico provider accounts and launch gates

Verified against official provider documentation on October 7, 2026. Public website: `https://metrico.live`; embedded frontend: `https://app.metrico.live`; backend: `https://api.metrico.live`. These URLs must be deployed with HTTPS before production OAuth works. Configure the provider accounts now; complete verification videos and live tests after deployment. Keep secrets in local environment files and deployment secret storage, never commits or screenshots.

## 1. Meta: finish your existing application

1. Open [Meta for Developers](https://developers.facebook.com/apps/) and the application that supplied your existing credentials. Keep its App ID and App Secret: `META_APP_ID` and `META_APP_SECRET`.
2. In the Facebook Login for Business configuration used by the app, register the exact valid OAuth redirect URI `https://api.metrico.live/v1/integrations/meta/callback`. Configure `metrico.live` as the app domain and publish the website, privacy URL `https://metrico.live/privacy`, and data-deletion instructions `https://metrico.live/data-deletion`.
3. In [Business settings](https://business.facebook.com/settings/), create/use a real advertising account and assign your connecting Facebook user access. Use an account that has existing reporting history if available. Authentication with an empty account proves authorization, not reporting correctness. You do not need to start spending just to test an existing account.
4. Open [Events Manager](https://business.facebook.com/events_manager2/). Create or select the website dataset/pixel and assign it to the ad account and the user/business connecting to Metrico. The merchant selects that destination inside Metrico; no pixel token needs to be pasted into the merchant interface.
5. Initial reporting uses `ads_read`. Purchase sharing requests `ads_management` through a separate merchant consent action. If your enabled catalog features require additional permissions, request only those actually used. Complete Business Verification and App Review/Advanced Access for permissions required to serve merchants who are not application roles. Development-role testing is not proof of public access.
6. Set `META_STATE_SECRET` to a fresh random secret. Keep `META_SCOPES=ads_read` for initial authorization; use the purchase-sharing permission button for the additional grant. Registering a URL and putting an app in Live mode do not grant missing permissions.
7. After deployment: connect, choose the correct account, sync a date range with known spend, compare account/campaign totals with Ads Manager using the same dates, timezone, currency, and attribution settings. Then turn on purchase sharing and make a consented storefront test purchase. Confirm a server event in Events Manager, its value/currency/event ID, and Metrico delivery status. A received event is not necessarily an attributed conversion. If browser pairing is enabled, verify deduplication and that another Shopify app is not also sending the same purchase.

Official reference: [Conversions API](https://developers.facebook.com/docs/marketing-api/conversions-api/).

## 2. TikTok: correct the app you already created

Your screenshot shows API for Business app `7683136035535863828`, currently named Stride. It also shows an advertiser redirect URL ending in `/v1/integrations/meta/callback`, which is incorrect for TikTok.

1. Open [TikTok API for Business](https://business-api.tiktok.com/portal/) and that app. Rebrand its displayed name/website to Metrico where the portal permits.
2. Replace the incorrect redirect with `https://api.metrico.live/v1/integrations/tiktok/callback`. Match scheme, hostname and path exactly. For local tests, register a separate public HTTPS backend tunnel with the same TikTok callback path if the portal permits multiple URLs. Do not use the frontend origin or the Meta callback.
3. Copy App ID to `TIKTOK_APP_ID`, App Secret to `TIKTOK_APP_SECRET`. Generate a separate `TIKTOK_STATE_SECRET`. Production derives the redirect and webhook URLs from `APP_URL`; remove stale local overrides.
4. Verify the app is approved for the API endpoints used by your enabled features: advertiser discovery/account information, campaign/ad group/ad reads, integrated reporting, and (for purchase sharing) `pixel/list` and `event/track`. Request applicable measurement/Events API permissions in the portal and complete its review with real domain, privacy policy and use-case evidence. Permission names and eligibility can differ by app; do not invent a scope string or treat the screenshot's ad-account permission as Events API approval.
5. In [TikTok Ads Manager](https://ads.tiktok.com/), create/use an advertiser account. Assign the authorizing user access through your Business Center. In Events Manager, create/select a web pixel/dataset under the same advertiser. Record advertiser ID and pixel code for verification; Metrico discovers the destination after the user selects an advertiser.
6. Keep `TIKTOK_EVENTS_API_ENABLED=false` until the app's OAuth token is verified to authorize both pixel discovery and event ingestion. Then set it true and reconnect if new permissions need consent. The flag only exposes supported code; it cannot grant TikTok approval. Reporting can stay connected independently.
7. After deployment: authenticate, select the advertiser, sync known historical campaigns and compare reporting. Enable purchase sharing, make a consented storefront test purchase, and inspect TikTok Events Manager/Test Events, API receipt and delivery activity. Confirm event name Purchase, value, currency and event ID; test revoked access and consent withdrawal. No historical campaigns means reporting remains unvalidated.

Official implementation references: [TikTok measurement SDK](https://github.com/tiktok/tiktok-business-api-sdk/blob/main/js_sdk/docs/MeasurementApi.md) and the [Business API documentation](https://business-api.tiktok.com/portal/docs).

## 3. Google: create the Cloud project and OAuth application

**Current onboarding changed:** Google Ads developer tokens were sunset September 9, 2026. Access is attached to the Google Cloud project that owns the OAuth client. Do not apply for a developer token through the old manager-account API Center, and do not set `GOOGLE_ADS_DEVELOPER_TOKEN` for this release.

1. Open [Google Cloud project creation](https://console.cloud.google.com/projectcreate). Create a dedicated Metrico project. Record its project ID and project number for administration; they are not backend secrets required by this integration.
2. In the selected project, enable [Google Ads API](https://console.cloud.google.com/apis/library/googleads.googleapis.com) and [Data Manager API](https://console.cloud.google.com/apis/library/datamanager.googleapis.com). Metrico uses Ads API for account discovery/reporting and Data Manager for purchase ingestion.
3. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview). Configure Branding: Metrico, a monitored support email, `https://metrico.live`, `https://metrico.live/privacy`, `https://metrico.live/terms`, authorized domain `metrico.live`, and your real developer contact. Configure Audience as External for merchants outside your organization. While testing, add your own Google account as a test user.
4. Verify `metrico.live` ownership in [Search Console](https://search.google.com/search-console) using the DNS TXT record supplied by Google. The Google account responsible for OAuth verification must have verified ownership/access. Brand verification needs live, accessible public pages, so finish submission after deployment.
5. In Data Access, add exactly `https://www.googleapis.com/auth/adwords` and `https://www.googleapis.com/auth/datamanager`. Metrico already requests both. Submit the required scope/brand verification with the use-case explanation and a video showing merchant consent, account selection, reporting, purchase sharing and disconnect. Google may request more evidence. External Testing OAuth refresh tokens commonly expire after seven days for these scopes; do not launch with a permanent testing-only configuration.
6. In Clients, create an OAuth client of type **Web application**. Register `https://api.metrico.live/v1/integrations/google-ads/callback` as an authorized redirect URI. Metrico uses a server OAuth flow: no service-account JSON key, browser API key or manually generated refresh token is needed. Copy its Client ID to `GOOGLE_ADS_CLIENT_ID`, Client Secret to `GOOGLE_ADS_CLIENT_SECRET`, and generate a fresh `GOOGLE_ADS_STATE_SECRET`. These are separate from the optional legacy Google login variables `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`.
7. Open [Google Ads API Overview](https://console.cloud.google.com/apis/api/googleads.googleapis.com/overview) in that SAME project. Enabling the API initially gives Test access. Under Upgrade access level, apply for Explorer if available: it permits production accounts with 2,880 operations/day. Basic provides 15,000/day and requires brand verification. Start with the access your expected workload needs; OAuth verification and Ads API access level are separate gates. Track project quota and move to Basic as merchant sync load grows.
8. Create/use a [Google Ads account](https://ads.google.com/) and grant the Google user connecting to Metrico access to the advertiser (or its parent manager). Record the 10-digit advertiser customer ID. A manager account is useful when managing many clients but is no longer a requirement to apply for Ads API access. The backend discovers customers and manager context from merchant authorization.
9. For server purchase sharing, configure an eligible import/upload conversion action with Purchase category in the operating advertiser account. The implementation selects enabled, advertiser-owned `UPLOAD_CLICKS` Purchase actions; website-tag actions and manager-owned actions are not offered. Follow [Google's conversion-action guidance](https://developers.google.com/google-ads/api/docs/conversions/create-conversion-actions). This does not require installing a second browser tag. Ensure customer-data terms/consent settings applicable to the destination are accepted.
10. After deployment: connect with your authorized Google user, select the advertiser, sync known historical metrics and compare against Google Ads with matching dates/timezone/currency. Enable the discovered purchase destination, generate a genuine permitted conversion and check the Data Manager ingestion result plus Google Ads conversion diagnostics. Test accounts cannot prove real ad attribution, and an ingestion receipt does not prove that Google attributed the sale. Never fabricate click IDs or campaign spend to make a check appear to pass.

Official current references: [developer-token sunset](https://developers.google.com/google-ads/api/docs/api-policy/developer-token), [project access levels](https://developers.google.com/google-ads/api/docs/api-policy/access-levels), [Data Manager access](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access), [brand verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/brand-verification).

## Generating local state secrets

Run this separately for each provider, Shopify state, and JWT secret, in your VS Code terminal. Store the result in the appropriate local environment file; do not send it in chat.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For a NEW `TOKEN_ENCRYPTION_KEY`, use base64 instead of hex. Preserve your existing encryption key if encrypted tokens are already stored; replacing it without a rotation migration makes existing tokens unreadable.

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Merchant access/refresh tokens are acquired and encrypted by Metrico during authorization, not static deployment environment variables.

## Supabase audit and owner tasks

Read-only audit on October 7: project `sposmttjvlyvseakmpxj` (Shopify), eu-west-1, ACTIVE_HEALTHY; PostgreSQL 17; about 31 MiB; 89 application tables. Prisma has 53 completed migration records, 17 rolled-back records and no unresolved active failed migration. Do not delete/reset migration history. The 41 application tables with RLS disabled had no SELECT grants to anon/authenticated; this audit did not find evidence of public reads through those roles. Eight foreign-key indexes are missing. New migrations add the indexes and enable RLS/revoke browser-role access on all application tables.

Use [the project dashboard](https://supabase.com/dashboard/project/sposmttjvlyvseakmpxj) → Connect to retrieve DATABASE_URL. For IPv4-only AWS hosts, use the displayed session-pooler endpoint if the direct endpoint is IPv6-only. Keep TLS enabled. `MIGRATION_DATABASE_URL` can use a separate direct/session connection for Prisma CLI. Runtime and migration roles must own these backend tables or have BYPASSRLS; a constrained custom role needs explicit backend policies. This is a backend-only Prisma database; do not add anonymous/authenticated read policies or expose a service-role key in frontend code.

Keep this project, deploy the migrations through the release process, then rerun advisors and verify application reads/writes. Check remaining capacity and your plan's pause/backups settings. Configure encrypted off-host backups with retention and a restore test before collecting paying clients' data. Put AWS in Ireland to reduce API/database latency. Supabase secrets are independent of GitHub image-build public configuration.

## Remaining gates and order

| Work                                                                                                     | Owner                             | Earliest time         | Depends on                                                                                 |
| -------------------------------------------------------------------------------------------------------- | --------------------------------- | --------------------- | ------------------------------------------------------------------------------------------ |
| Provider account credentials and approval applications                                                   | Ahmed                             | Now                   | Provider admin access                                                                      |
| Monitored support mailbox and domain DNS ownership                                                       | Ahmed                             | Now                   | Domain registrar/DNS                                                                       |
| Shopify protected customer-data request actually submitted, not Draft                                    | Ahmed                             | Now                   | Exact fields/purposes/privacy explanation                                                  |
| Shopify App Pricing plans and Partner API access                                                         | Ahmed                             | Now                   | Public app configuration; paid production startup requires these                           |
| Redis REST URL/token for OAuth replay protection, shared limits and queues                               | Ahmed                             | Before deployment     | Redis-compatible REST service; not a raw redis:// URL                                      |
| Build/release workflows and app fixes                                                                    | Code PRs                          | Before deployment     | CI; frontend public build variables                                                        |
| HTTPS, production URL registration, application migrations                                               | Ahmed with deployment walkthrough | Deployment            | AWS host, DNS, pinned images, backend secrets                                              |
| Live reporting, consent, purchase delivery, deduplication, MCP OAuth, uninstall/reinstall, billing tests | Ahmed with assisted diagnosis     | After deployment      | Accounts, permissions, worker running                                                      |
| Shopify App Store submission                                                                             | Ahmed                             | After live tests      | Contact/listing assets, reviewer steps, approvals, hosted pricing and valid production app |
| Marketing and paid acquisition                                                                           | Ahmed                             | After verified launch | Approved listing, truthful feature claims and working onboarding                           |

Built for Shopify highlights are separate from baseline App Store acceptance. Do not claim them before Shopify awards them. The current theme and Web Pixel extensions belong to this same Metrico Shopify app. Keep the required pixel API scopes in app configuration; hiding technical scope text in merchant UI does not mean removing scopes necessary for installation.
