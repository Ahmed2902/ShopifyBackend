import type { StoreAccessClaim, StoreRoleClaim } from '../modules/auth/auth.utils.js';

declare module 'express-serve-static-core' {
  interface Request {
    rawBody?: Buffer;
    context: {
      userId?: string;
      storeId?: string;
      role?: StoreRoleClaim;
      storeAccess?: StoreAccessClaim[];
    };
  }
}

export {};
