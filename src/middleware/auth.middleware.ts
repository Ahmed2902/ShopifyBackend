import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import { verifyAccessToken } from '../modules/auth/auth.utils.js';
import { shopifyEmbeddedAuthService } from '../modules/shopify/shared/shopify-embedded-auth.service.js';

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');

  if (shopifyEmbeddedAuthService.looksLikeShopifyIdToken(token)) {
    try {
      const context = await shopifyEmbeddedAuthService.authenticate(token);
      req.context.userId = context.userId;
      req.context.storeAccess = context.stores;
      req.context.authSource = 'SHOPIFY_ID_TOKEN';
      req.context.shopifyUserId = context.shopifyUserId;
      req.context.shopifyShopDomain = context.shopDomain;
      next();
      return;
    } catch (error) {
      if (error instanceof AppError && error.code === 'SHOPIFY_ID_TOKEN_INVALID') {
        res.setHeader('X-Shopify-Retry-Invalid-Session-Request', '1');
      }
      throw error;
    }
  }

  const context = await verifyAccessToken(token);
  req.context.userId = context.userId;
  req.context.storeAccess = context.stores;
  req.context.authSource = 'STRIDE_JWT';
  next();
};
