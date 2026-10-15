import type { AdvertisingProvider } from '../../generated/prisma/client.js';

// Conservative Metrico acceptance limits. Keep separate from touch attribution lookback.
// Meta: developers.facebook.com/docs/marketing-api/conversions-api/parameters/server-event
// TikTok: business-api.tiktok.com/portal/docs (Web Events API event_time)
// Google remains gated and uses our conservative seven-day retention, not a claimed API limit.
export const DELIVERY_AGE_MS: Record<AdvertisingProvider, number> = {
  META: 7 * 86400_000, TIKTOK: 7 * 86400_000, GOOGLE_ADS: 7 * 86400_000,
};
export const DELIVERY_SAFETY_MARGIN_MS = 5 * 60_000;
export const MAX_BROWSER_CLOCK_LEAD_MS = 5_000;
export function deliveryDeadline(provider: AdvertisingProvider, eventAt: Date) {
  return new Date(eventAt.getTime() + DELIVERY_AGE_MS[provider] - DELIVERY_SAFETY_MARGIN_MS);
}
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const seconds = /^\d+(?:\.\d+)?$/.test(trimmed) ? Number(trimmed) : NaN;
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(trimmed) - now;
  return Number.isFinite(ms) && ms >= 0 ? Math.min(ms, 7 * 86400_000) : undefined;
}
export function retryDelayMs(attempt: number, retryAfter: number | undefined, random = Math.random) {
  const base = Math.min(60_000 * 2 ** Math.min(Math.max(attempt - 1, 0), 8), 6 * 3600_000);
  return Math.max(Math.floor(base * (.5 + random() * .5)), retryAfter ?? 0);
}
