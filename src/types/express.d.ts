import type { StoreAccessClaim, StoreRoleClaim } from './auth.js';

declare module 'express-serve-static-core' {
  interface Request {
    context: {
      userId?: string;
      storeId?: string;
      role?: StoreRoleClaim;
      storeAccess?: StoreAccessClaim[];
    };
  }
}

export {};
