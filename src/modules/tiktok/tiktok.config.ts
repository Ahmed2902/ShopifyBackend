import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

function hasTikTokPublicBackendUrls(): boolean {
  if (env.NODE_ENV !== 'production') return true;
  if (env.APP_URL) return true;
  return Boolean(env.TIKTOK_REDIRECT_URI && env.TIKTOK_WEBHOOK_URL_EXPLICIT);
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
