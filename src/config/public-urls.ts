import { env } from './env.js';

function backendOrigin(): string {
  return new URL(env.APP_URL).origin;
}

function backendCallback(path: string, legacyOverride?: string): string {
  // Production uses one canonical backend URL so stale provider-specific callback
  // variables cannot silently send OAuth back to localhost or an old deployment.
  if (env.NODE_ENV === 'production') {
    return new URL(path, `${backendOrigin()}/`).toString();
  }
  if (legacyOverride) return new URL(legacyOverride).toString();
  return new URL(path, `${backendOrigin()}/`).toString();
}

export function frontendUrl(path: string): string {
  return new URL(path, `${env.FRONTEND_URL}/`).toString();
}

export function googleCallbackUrl(): string {
  return backendCallback('/v1/auth/google/callback', env.GOOGLE_REDIRECT_URI);
}

export function googleFrontendCallbackUrl(errorCode?: string): string {
  if (env.NODE_ENV !== 'production' && env.GOOGLE_FRONTEND_REDIRECT_URI) {
    const destination = new URL(env.GOOGLE_FRONTEND_REDIRECT_URI);
    if (errorCode) destination.searchParams.set('error', errorCode);
    return destination.toString();
  }
  const destination = new URL(frontendUrl('/auth/callback'));
  if (errorCode) destination.searchParams.set('error', errorCode);
  return destination.toString();
}

export function shopifyCallbackUrl(): string {
  // Shopify OAuth must use the exact callback registered for the active app version.
  // Keep it explicit instead of deriving it from APP_URL or FRONTEND_URL so deployment
  // configuration and Shopify's whitelist cannot silently drift apart.
  return new URL(env.SHOPIFY_REDIRECT_URI).toString();
}

export function metaCallbackUrl(): string {
  return backendCallback('/v1/integrations/meta/callback', env.META_REDIRECT_URI);
}

export function tiktokCallbackUrl(): string {
  return backendCallback('/v1/integrations/tiktok/callback', env.TIKTOK_REDIRECT_URI);
}

export function tiktokWebhookUrl(): string {
  return backendCallback('/v1/integrations/tiktok/webhooks', env.TIKTOK_WEBHOOK_URL);
}
