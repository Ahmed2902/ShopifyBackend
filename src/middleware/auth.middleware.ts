import type { Request, RequestHandler, Response } from 'express';
import { decodeJwt } from 'jose';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';
import { verifyAccessToken } from '../modules/auth/auth.utils.js';
import { shopifyEmbeddedAuthService } from '../modules/shopify/embedded/shopify-embedded-auth.service.js';

function bearerToken(req: Request): string {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  }
  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  return token;
}

function looksLikeShopifyIdToken(token: string): boolean {
  try {
    const payload = decodeJwt(token);
    const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    return audience.includes(env.SHOPIFY_CLIENT_ID) && typeof payload.dest === 'string';
  } catch {
    return false;
  }
}

async function authenticateShopify(
  req: Request,
  res: Response,
  token: string,
  refreshIdentity = false,
) {
  try {
    const session = await shopifyEmbeddedAuthService.authenticate(token, { refreshIdentity });
    req.context.userId = session.userId;
    req.context.storeId = session.storeId;
    req.context.role = session.role;
    req.context.storeAccess = session.storeAccess;
    req.context.authSource = 'SHOPIFY';
    req.context.shopifyShop = session.shop;
    req.context.shopifyUserId = session.shopifyUserId;
  } catch (error) {
    if (error instanceof AppError && error.statusCode === 401) {
      // App Bridge observes this header, obtains a fresh ID token, and retries an XHR/fetch once.
      res.setHeader('X-Shopify-Retry-Invalid-Session-Request', '1');
    }
    throw error;
  }
}

/**
 * Migration-compatible application authentication.
 *
 * Embedded Shopify requests use App Bridge ID tokens and are the authoritative production path.
 * Legacy Stride JWTs are accepted only when the explicit rollback flag is enabled, except for the
 * short-lived token minted by the local development auto-session route while NODE_ENV=development.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req);

  if (looksLikeShopifyIdToken(token)) {
    await authenticateShopify(req, res, token);
    next();
    return;
  }

  const developmentSessionAllowed = env.NODE_ENV === 'development' && env.DEV_AUTO_SESSION_ENABLED;
  if (!env.LEGACY_MERCHANT_AUTH_ENABLED && !developmentSessionAllowed) {
    throw new AppError('Open Stride from Shopify Admin to sign in.', 401, 'SHOPIFY_AUTH_REQUIRED');
  }
  const context = await verifyAccessToken(token);
  req.context.userId = context.userId;
  req.context.storeAccess = context.stores;
  req.context.authSource = 'LEGACY';
  next();
};

/**
 * Require a Shopify embedded session and refresh Shopify's account-owner signal. The frontend calls
 * this once when App Bridge boots; ordinary API calls can then use the cached identity mapping.
 */
export const requireShopifyAppAuth: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req);
  await authenticateShopify(req, res, token, true);
  next();
};
