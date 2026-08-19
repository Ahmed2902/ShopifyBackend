import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const OAUTH_CONTEXT_TTL_MS = 10 * 60 * 1000;
export const SHOPIFY_OAUTH_COOKIE_NAME = 'shopify_oauth_context';

export interface ShopifyOAuthContext {
  state: string;
  userId: string;
  shop: string;
  expiresAt: number;
}

function safeEqual(left: string, right: string, encoding: BufferEncoding = 'utf8'): boolean {
  const leftBuffer = Buffer.from(left, encoding);
  const rightBuffer = Buffer.from(right, encoding);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

// region Shop domain and OAuth context
export function normalizeShopDomain(input: string): string {
  const raw = input.trim().toLowerCase();
  let hostname = raw;

  if (raw.startsWith('https://') || raw.startsWith('http://')) {
    try {
      const url = new URL(raw);
      if (url.username || url.password || url.port || (url.pathname !== '/' && url.pathname !== '')) {
        throw new Error('Unexpected URL components');
      }
      hostname = url.hostname;
    } catch {
      throw new AppError('Invalid Shopify store domain', 400, 'INVALID_SHOP_DOMAIN');
    }
  }

  if (!/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(hostname)) {
    throw new AppError('Shop must be a valid *.myshopify.com domain', 400, 'INVALID_SHOP_DOMAIN');
  }

  return hostname;
}

function signContextPayload(payload: string): string {
  return createHmac('sha256', env.SHOPIFY_STATE_SECRET).update(payload).digest('base64url');
}

export function createShopifyOAuthContext(userId: string, shop: string) {
  const context: ShopifyOAuthContext = {
    state: randomBytes(32).toString('base64url'),
    userId,
    shop,
    expiresAt: Date.now() + OAUTH_CONTEXT_TTL_MS,
  };
  const payload = Buffer.from(JSON.stringify(context), 'utf8').toString('base64url');

  return {
    state: context.state,
    cookieValue: `${payload}.${signContextPayload(payload)}`,
  };
}

export function verifyShopifyOAuthContext(cookieValue: string | undefined): ShopifyOAuthContext {
  if (!cookieValue) throw new AppError('Shopify OAuth context is missing', 401, 'INVALID_OAUTH_STATE');

  const [payload, signature, ...extra] = cookieValue.split('.');
  if (!payload || !signature || extra.length > 0 || !safeEqual(signContextPayload(payload), signature)) {
    throw new AppError('Shopify OAuth context is invalid', 401, 'INVALID_OAUTH_STATE');
  }

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as ShopifyOAuthContext;
    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.userId !== 'string' ||
      typeof parsed.shop !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      parsed.expiresAt < Date.now()
    ) {
      throw new Error('Invalid context payload');
    }
    return parsed;
  } catch {
    throw new AppError('Shopify OAuth context is invalid or expired', 401, 'INVALID_OAUTH_STATE');
  }
}

export function buildShopifyAuthorizationUrl(shop: string, state: string): string {
  const url = new URL(`https://${shop}/admin/oauth/authorize`);
  url.searchParams.set('client_id', env.SHOPIFY_CLIENT_ID);
  url.searchParams.set('scope', env.SHOPIFY_SCOPES);
  url.searchParams.set('redirect_uri', env.SHOPIFY_REDIRECT_URI);
  url.searchParams.set('state', state);
  return url.toString();
}
// endregion

// region Callback verification
export function computeShopifyOAuthHmac(searchParams: URLSearchParams): string {
  const entries = Array.from(searchParams.entries())
    .filter(([key]) => key !== 'hmac')
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey),
    );

  const message = entries.map(([key, value]) => `${key}=${value}`).join('&');
  return createHmac('sha256', env.SHOPIFY_CLIENT_SECRET).update(message).digest('hex');
}

export function verifyShopifyOAuthHmac(searchParams: URLSearchParams): void {
  const provided = searchParams.get('hmac');
  if (!provided || !/^[a-f0-9]{64}$/i.test(provided)) {
    throw new AppError('Invalid Shopify OAuth signature', 401, 'INVALID_SHOPIFY_HMAC');
  }

  const expected = computeShopifyOAuthHmac(searchParams);
  if (!safeEqual(expected.toLowerCase(), provided.toLowerCase())) {
    throw new AppError('Invalid Shopify OAuth signature', 401, 'INVALID_SHOPIFY_HMAC');
  }
}

export function verifyShopifyCallbackTimestamp(timestamp: string): void {
  const seconds = Number(timestamp);
  if (!Number.isFinite(seconds)) {
    throw new AppError('Invalid Shopify callback timestamp', 401, 'INVALID_SHOPIFY_TIMESTAMP');
  }

  if (Math.abs(Date.now() - seconds * 1000) > OAUTH_CONTEXT_TTL_MS) {
    throw new AppError('Shopify callback timestamp is stale', 401, 'INVALID_SHOPIFY_TIMESTAMP');
  }
}
// endregion

// region Cookie and redirect
function oauthCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/integrations/shopify',
  };
}

export function setShopifyOAuthCookie(res: Response, value: string): void {
  res.cookie(SHOPIFY_OAUTH_COOKIE_NAME, value, {
    ...oauthCookieOptions(),
    maxAge: OAUTH_CONTEXT_TTL_MS,
  });
}

export function clearShopifyOAuthCookie(res: Response): void {
  res.clearCookie(SHOPIFY_OAUTH_COOKIE_NAME, oauthCookieOptions());
}

export function buildShopifySuccessRedirect(storeId: string, shop: string): string {
  const destination = new URL('/settings/integrations', env.CORS_ORIGIN);
  destination.searchParams.set('shopify', 'connected');
  destination.searchParams.set('storeId', storeId);
  destination.searchParams.set('shop', shop);
  return destination.toString();
}
// endregion
