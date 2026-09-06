import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

export function requireTikTokAppCredentials(): { appId: string; appSecret: string } {
  if (!env.TIKTOK_APP_ID || !env.TIKTOK_APP_SECRET) {
    throw new AppError(
      'TikTok integration is not configured',
      503,
      'TIKTOK_NOT_CONFIGURED',
    );
  }

  return {
    appId: env.TIKTOK_APP_ID,
    appSecret: env.TIKTOK_APP_SECRET,
  };
}

export function requireTikTokStateSecret(): string {
  if (!env.TIKTOK_STATE_SECRET) {
    throw new AppError(
      'TikTok integration is not configured',
      503,
      'TIKTOK_NOT_CONFIGURED',
    );
  }

  return env.TIKTOK_STATE_SECRET;
}
