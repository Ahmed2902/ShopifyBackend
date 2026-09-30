import type { StoreAccessClaim, StoreRoleClaim } from './auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer;
    context: {
      userId?: string;
      storeId?: string;
      role?: StoreRoleClaim;
      storeAccess?: StoreAccessClaim[];
      authSource?: 'STRIDE_JWT' | 'SHOPIFY_ID_TOKEN';
      shopifyUserId?: string;
      shopifyShopDomain?: string;
    };
  }
}

export {};
