import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { TikTokOAuthContext } from './tiktok.types.js';

const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, 'utf8');
  const rightBuffer = Buffer.from(right, 'utf8');
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function signState(payload: string): string {
  return createHmac('sha256', env.TIKTOK_STATE_SECRET).update(payload).digest('base64url');
}

export function createTikTokOAuthState(userId: string, storeId: string): string {
  const context: TikTokOAuthContext = {
    nonce: randomBytes(32).toString('base64url'),
    userId,
    storeId,
    expiresAt: Date.now() + OAUTH_STATE_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');
  return `${payload}.${signState(payload)}`;
}

export function verifyTikTokOAuthState(state: string | undefined): TikTokOAuthContext {
  if (!state) throw new AppError('TikTok OAuth state is missing', 401, 'INVALID_TIKTOK_OAUTH_STATE');
  const [payload, signature, ...extra] = state.split('.');
  if (!payload || !signature || extra.length > 0 || !safeEqual(signState(payload), signature)) {
    throw new AppError('TikTok OAuth state is invalid', 401, 'INVALID_TIKTOK_OAUTH_STATE');
  }

  try {
    const context = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TikTokOAuthContext;
    if (
      typeof context.nonce !== 'string' ||
      context.nonce.length < 32 ||
      typeof context.userId !== 'string' ||
      typeof context.storeId !== 'string' ||
      typeof context.expiresAt !== 'number' ||
      context.expiresAt < Date.now()
    ) {
      throw new Error('Invalid context');
    }
    return context;
  } catch {
    throw new AppError('TikTok OAuth state is invalid or expired', 401, 'INVALID_TIKTOK_OAUTH_STATE');
  }
}

export function configuredTikTokScopes(): string[] {
  return [...new Set(env.TIKTOK_SCOPES.split(',').map((scope) => scope.trim()).filter(Boolean))];
}

export function buildTikTokAuthorizationUrl(userId: string, storeId: string) {
  const state = createTikTokOAuthState(userId, storeId);
  const url = new URL('https://ads.tiktok.com/marketing_api/auth');
  url.searchParams.set('app_id', env.TIKTOK_APP_ID);
  url.searchParams.set('redirect_uri', env.TIKTOK_REDIRECT_URI);
  url.searchParams.set('state', state);
  const scopes = configuredTikTokScopes();
  if (scopes.length > 0) url.searchParams.set('scope', scopes.join(','));
  return { authorizationUrl: url.toString(), state };
}

export function buildTikTokSuccessRedirect(storeId: string): string {
  const destination = new URL('/app/integrations', env.CORS_ORIGIN);
  destination.searchParams.set('tiktok', 'connected');
  destination.searchParams.set('storeId', storeId);
  return destination.toString();
}

export function parseTikTokDate(value: unknown): Date | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const millis = value < 10_000_000_000 ? value * 1000 : value;
    const date = new Date(millis);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string' || value.trim() === '') return null;
  if (/^\d{10,13}$/.test(value)) return parseTikTokDate(Number(value));
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function asString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'bigint') return String(value);
  return null;
}

export function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((item): item is string => Boolean(item)) : [];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function toJsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, current) => (typeof current === 'bigint' ? current.toString() : current)),
  ) as unknown;
}

export function deriveTikTokDeliveryId(payload: unknown, rawBody: Buffer): string {
  const record = asRecord(payload);
  const explicit = asString(record.request_id) ?? asString(record.event_id) ?? asString(record.eventId);
  if (explicit) return explicit;
  return createHash('sha256').update(rawBody).digest('hex');
}

export function getTikTokWebhookTopic(payload: unknown): string {
  const record = asRecord(payload);
  const explicit = asString(record.event) ?? asString(record.event_type) ?? asString(record.type);
  if (explicit) return explicit;
  const object = asNumber(record.object);
  const topics: Record<number, string> = {
    1: 'LEAD',
    2: 'AD_GROUP_REVIEW',
    3: 'AD_REVIEW',
    4: 'TCM_ORDER',
    8: 'CREATIVE_FATIGUE',
    10: 'TCM_VIDEOS',
    11: 'REPORT_DATA_CHANGE',
  };
  return object === null ? 'UNKNOWN' : topics[object] ?? `WEBHOOK_${object}`;
}

export function getTikTokWebhookAdvertiserIds(payload: unknown): string[] {
  const record = asRecord(payload);
  const data = asRecord(record.data);
  const ids = new Set<string>();
  for (const candidate of [record.advertiser_id, record.adv_id, data.advertiser_id, data.adv_id]) {
    const id = asString(candidate);
    if (id) ids.add(id);
  }
  if (Array.isArray(record.entry)) {
    for (const rawEntry of record.entry) {
      const entry = asRecord(rawEntry);
      const id = asString(entry.adv_id) ?? asString(entry.advertiser_id);
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

export function getTikTokWebhookAdvertiserId(payload: unknown): string | null {
  return getTikTokWebhookAdvertiserIds(payload)[0] ?? null;
}

export function verifyTikTokWebhookToken(token: string | undefined): void {
  if (!token || !safeEqual(token, env.TIKTOK_WEBHOOK_TOKEN)) {
    throw new AppError('TikTok webhook token is invalid', 401, 'INVALID_TIKTOK_WEBHOOK_TOKEN');
  }
}

export function verifyTikTokWebhookSignature(
  rawBody: Buffer | undefined,
  signatureHeader: string | undefined,
): void {
  if (!rawBody || !signatureHeader) {
    throw new AppError('TikTok webhook signature is missing', 401, 'INVALID_TIKTOK_WEBHOOK_SIGNATURE');
  }

  const parts = new Map(
    signatureHeader.split(',').map((item) => {
      const [key, ...rest] = item.trim().split('=');
      return [key, rest.join('=')];
    }),
  );
  const timestamp = parts.get('t');
  const signature = parts.get('s');
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) {
    throw new AppError('TikTok webhook signature is invalid', 401, 'INVALID_TIKTOK_WEBHOOK_SIGNATURE');
  }

  const ageSeconds = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (ageSeconds > env.TIKTOK_WEBHOOK_MAX_AGE_SECONDS) {
    throw new AppError('TikTok webhook signature is expired', 401, 'EXPIRED_TIKTOK_WEBHOOK_SIGNATURE');
  }

  const expected = createHmac('sha256', env.TIKTOK_APP_SECRET)
    .update(`${timestamp}.${rawBody.toString('utf8')}`)
    .digest('hex');
  if (!safeEqual(expected, signature)) {
    throw new AppError('TikTok webhook signature is invalid', 401, 'INVALID_TIKTOK_WEBHOOK_SIGNATURE');
  }
}
