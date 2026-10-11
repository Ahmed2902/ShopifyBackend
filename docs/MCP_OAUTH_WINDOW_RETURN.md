# MCP OAuth return and Shopify pricing checks

MCP authorization starts in a browser window opened by the AI client. Shopify approval happens in a separate authenticated admin tab. Sending the callback to a third tab can lose the client's per-window callback state and produce “Missing OAuth callback data”.

The backend now attaches an opaque return capability to the authorization handoff's URL fragment. Only its SHA-256 digest is stored. The original window polls a public, rate-limited POST endpoint with that capability in the request body. Shopify still authenticates and approves the exact store through the existing consent endpoints. Approval atomically claims the pending request, creates the one-use PKCE authorization code, and stores an encrypted callback. Denial stores an encrypted OAuth error. A request ID alone cannot retrieve either result.

Repeated consent reads cannot erase a completed result. Polling may retry safely while the result is valid; token exchange remains one-use and continues to verify PKCE, client, resource, redirect URI and store membership. Expired handoffs are pruned when a new connection starts.

## Deployment and live check

1. Merge and deploy the backend first. Its normal migration-first startup applies `20261011090000_mcp_oauth_window_return`.
2. Deploy the matching frontend change. No new environment variables are needed.
3. Confirm `APP_URL` is `https://api.metrico.live`, `FRONTEND_URL` is the deployed frontend origin, and `CORS_ORIGIN` permits that frontend origin. Keep the existing token encryption key stable.
4. Start a **new** Metrico connector connection from ChatGPT or Claude. Do not reuse a consumed/expired request.
5. Keep the authorization window open. In Shopify Admin, open Apps → Metrico → Developer → MCP access, paste the request ID and approve the store.
6. Switch back to the original authorization window. It should return automatically to the client with the original state and issuer. No third callback tab should open.
7. Verify connector tools can actually read the selected store. Active plan entitlements still apply independently of OAuth success.
8. Repeat with denial. The original window should return an `access_denied` result. Repeat with an expired request and confirm that it requires restarting.

Older pending requests without the capability keep their legacy return link. Start fresh after both deployments to exercise the fix.

## Shopify hosted pricing 404

The URL builder follows Shopify's documented `/store/:store_handle/charges/:app_handle/pricing_plans` pattern. A Shopify-rendered 404 does not establish an API/container failure and does not identify a single cause.

For the exact public Metrico app installed on the dev store, inspect Partner Dashboard → App distribution → All apps → Metrico → Distribution → Manage listing → Edit listing language → Pricing content → Manage:

- Confirm Shopify App Pricing is selected in pricing Settings.
- Match the dev store and listing locales. Shopify documents a draft-app pricing-page 404 when those locales differ. For an English listing, test with matching English settings before diagnosing other causes.
- Copy the actual app handle from the hosted pricing URL/linked app configuration into `SHOPIFY_APP_HANDLE`. The display name is not proof of the handle.
- Ensure Essentials and Pro are saved and available to the test store, with descriptions for its language and 14 trial days configured as intended.
- Copy the actual subscription-item handles into `SHOPIFY_ESSENTIALS_PLAN_HANDLE` and `SHOPIFY_PRO_PLAN_HANDLE`.
- Confirm `SHOPIFY_PARTNER_APP_ID`, organization ID and Partner API access token belong to that same app and organization. Do not reuse the old Stride app's configuration.
- For embedded plan welcome links, use the app-relative billing route and verify the resolved destination is `/app/billing`.

If the handle, pricing mode, plan availability and matching locales are verified but the hosted page still returns 404, escalate to Shopify Partner Support with the app ID, test-store domain and listing locale. Do not assume publishing approval is required to test billing.

Approve a plan, return to Metrico, and refresh subscription status. Never bypass billing or mark a subscription active locally to work around the hosted page. On a dev store in the same Partner organization, available App Pricing plans can be selected at no charge.

Reference: https://shopify.dev/docs/apps/launch/billing/shopify-app-pricing
