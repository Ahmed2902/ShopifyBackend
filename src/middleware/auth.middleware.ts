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

async function authenticateShopify(req: Request, res: Response, token: string) {
  try {
    const session = await shopifyEmbeddedAuthService.authenticate(token);
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
 * Existing Stride JWTs remain temporarily accepted so the current standalone frontend can be cut
 * over without breaking Meta/TikTok/Google/MCP setup flows mid-stack.
 */
export const requireAuth: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req);

  if (looksLikeShopifyIdToken(token)) {
    await authenticateShopify(req, res, token);
    next();
    return;
  }

  const context = await verifyAccessToken(token);
  req.context.userId = context.userId;
  req.context.storeAccess = context.stores;
  req.context.authSource = 'LEGACY';
  next();
};

/** Require the request to come from an authenticated Shopify embedded session. */
export const requireShopifyAppAuth: RequestHandler = async (req, res, next) => {
  const token = bearerToken(req);
  await authenticateShopify(req, res, token);
  next();
};
