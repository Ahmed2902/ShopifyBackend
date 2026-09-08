import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

function isLoopbackUrl(value: string): boolean {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
}

function hasTikTokPublicBackendUrls(): boolean {
  if (env.NODE_ENV !== 'production') return true;
  return !isLoopbackUrl(env.APP_URL);
}

export function requireTikTokAppCredentials(): { appId: string; appSecret: string } {
  if (!env.TIKTOK_APP_ID || !env.TIKTOK_APP_SECRET || !hasTikTokPublicBackendUrls()) {
    throw new AppError('TikTok integration is not configured', 503, 'TIKTOK_NOT_CONFIGURED');
  }
  return { appId: env.TIKTOK_APP_ID, appSecret: env.TIKTOK_APP_SECRET };
}

export function requireTikTokStateSecret(): string {
  if (env.TIKTOK_STATE_SECRET.length < 32) {
    throw new AppError('TikTok integration is not configured', 503, 'TIKTOK_NOT_CONFIGURED');
  }
  return env.TIKTOK_STATE_SECRET;
}
