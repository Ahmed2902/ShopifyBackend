import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';
const STATE_TTL_MS = 10 * 60_000;

type StatePayload = { userId: string; storeId: string; nonce: string; iat: number };

function base64url(value: string | Buffer) {
  return Buffer.from(value).toString('base64url');
}

function stateSecret() {
  const secret = env.GOOGLE_ADS_STATE_SECRET;
  if (!secret || secret.length < 32) {
    throw new AppError('Google Ads OAuth is not configured', 503, 'GOOGLE_ADS_NOT_CONFIGURED');
  }
  return secret;
}

export function normalizeCustomerId(value: string) {
  const normalized = value.replaceAll('-', '').trim();
  if (!/^\d{10}$/.test(normalized)) {
    throw new AppError('Invalid Google Ads customer ID', 400, 'GOOGLE_ADS_INVALID_CUSTOMER_ID');
  }
  return normalized;
}

export function buildGoogleAdsOAuthState(userId: string, storeId: string) {
  const payload: StatePayload = { userId, storeId, nonce: randomBytes(16).toString('hex'), iat: Date.now() };
  const encoded = base64url(JSON.stringify(payload));
  const signature = createHmac('sha256', stateSecret()).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

export function verifyGoogleAdsOAuthState(value: unknown): StatePayload {
  if (typeof value !== 'string') throw new AppError('Missing Google Ads OAuth state', 400, 'GOOGLE_ADS_BAD_STATE');
  const [encoded, signature, extra] = value.split('.');
  if (!encoded || !signature || extra) throw new AppError('Invalid Google Ads OAuth state', 400, 'GOOGLE_ADS_BAD_STATE');
  const expected = createHmac('sha256', stateSecret()).update(encoded).digest();
  const supplied = Buffer.from(signature, 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new AppError('Invalid Google Ads OAuth state', 400, 'GOOGLE_ADS_BAD_STATE');
  }
  let payload: StatePayload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as StatePayload; }
  catch { throw new AppError('Invalid Google Ads OAuth state', 400, 'GOOGLE_ADS_BAD_STATE'); }
  if (!payload.userId || !payload.storeId || !payload.nonce || !Number.isFinite(payload.iat) || Date.now() - payload.iat > STATE_TTL_MS) {
    throw new AppError('Expired Google Ads OAuth state', 400, 'GOOGLE_ADS_BAD_STATE');
  }
  return payload;
}

export function googleAdsRedirectUri() {
  return env.GOOGLE_ADS_REDIRECT_URI ?? new URL('/v1/integrations/google-ads/callback', `${env.APP_URL}/`).toString();
}

export function buildGoogleAdsAuthorizationUrl(userId: string, storeId: string) {
  if (!env.GOOGLE_ADS_CLIENT_ID) throw new AppError('Google Ads OAuth is not configured', 503, 'GOOGLE_ADS_NOT_CONFIGURED');
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', env.GOOGLE_ADS_CLIENT_ID);
  url.searchParams.set('redirect_uri', googleAdsRedirectUri());
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GOOGLE_ADS_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', buildGoogleAdsOAuthState(userId, storeId));
  return { authorizationUrl: url.toString() };
}

export function buildGoogleAdsSuccessRedirect(storeId: string) {
  const url = new URL('/settings/integrations', `${env.FRONTEND_URL}/`);
  url.searchParams.set('provider', 'GOOGLE_ADS');
  url.searchParams.set('status', 'connected');
  url.searchParams.set('storeId', storeId);
  return url.toString();
}

export function buildGoogleAdsErrorRedirect(storeId: string, code: string) {
  const url = new URL('/settings/integrations', `${env.FRONTEND_URL}/`);
  url.searchParams.set('provider', 'GOOGLE_ADS');
  url.searchParams.set('status', 'error');
  url.searchParams.set('code', code);
  url.searchParams.set('storeId', storeId);
  return url.toString();
}

export function deterministicUuid(...parts: string[]) {
  const bytes = createHash('sha256').update(parts.join('\u001f')).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

export function microsToDecimal(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const micros = BigInt(String(value));
  const negative = micros < 0n;
  const absolute = negative ? -micros : micros;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

export function googleDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  return new Date(`${value}T00:00:00.000Z`);
}

export function stringValue(value: unknown): string | null {
  if (typeof value === 'string' && value.length > 0) return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return null;
}

export function numberValue(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export const GOOGLE_ADS_OAUTH_SCOPE = GOOGLE_ADS_SCOPE;
