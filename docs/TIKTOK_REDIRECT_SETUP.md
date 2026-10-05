# TikTok advertising connection: return address

The message “The redirect URI does not match the developer app redirect URL”
happens on TikTok's authorization page before Metrico receives a callback.
It does not indicate a purchase conversion or Events API permission problem.

1. Find the running backend's public origin, configured as APP_URL.
2. Register that origin plus /v1/integrations/tiktok/callback as the redirect URL
   for the same TikTok API for Business app whose app ID the backend uses.
3. If TIKTOK_REDIRECT_URI is set in production, it must match that exact URL.
   The frontend /integrations/complete page is the final success page, not the
   callback TikTok should call.
4. Match HTTPS versus HTTP, hostname, port, path and trailing slash. Do not paste
   a percent-encoded URL into TikTok's settings or include authorization state.
5. Restart the backend after environment changes and begin a fresh connection.

For local development, expose the backend callback through a public HTTPS tunnel,
set TIKTOK_REDIRECT_URI to its /v1/integrations/tiktok/callback URL, and register
that same address in TikTok. If the tunnel address changes, update both settings.
Never expose the app secret or OAuth signing secret.

The release configuration check catches conflicting production callback values:

    npm run release:check-config -- --backend-env /secure/backend.env --frontend-env /secure/frontend.env

It cannot inspect or update your TikTok app registration. Successful advertising
OAuth does not enable managed TikTok purchase sharing; Events API authorization
remains a separate requirement.

Reference: https://business-api.tiktok.com/gateway/docs/index?doc_id=1738373141733378
