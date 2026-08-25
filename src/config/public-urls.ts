import { env } from './env.js';

function backendOrigin(): string {
  if (env.APP_URL) return new URL(env.APP_URL).origin;
  return `http://localhost:${env.PORT}`;
}

function backendCallback(path: string, legacyOverride?: string): string {
  // Production should have one canonical backend URL, like Systemly. This prevents
  // stale per-provider callback variables from silently sending OAuth elsewhere.
  if (env.NODE_ENV === 'production' && env.APP_URL) {
    return new URL(path, `${backendOrigin()}/`).toString();
  }
  if (legacyOverride) return new URL(legacyOverride).toString();
  return new URL(path, `${backendOrigin()}/`).toString();
}

export function frontendUrl(path: string): string {
  return new URL(path, `${new URL(env.CORS_ORIGIN).origin}/`).toString();
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

export function metaCallbackUrl(): string {
  return backendCallback('/v1/integrations/meta/callback', env.META_REDIRECT_URI);
}

export function tiktokCallbackUrl(): string {
  return backendCallback('/v1/integrations/tiktok/callback', env.TIKTOK_REDIRECT_URI);
}
