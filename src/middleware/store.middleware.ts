import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import type { StoreRoleClaim } from '../modules/auth/auth.utils.js';
import { storeParamsSchema } from '../modules/stores/store.schema.js';

export const requireStoreMembership: RequestHandler = (req, _res, next) => {
  if (!req.context.userId) {
    throw new AppError('Authentication context missing', 500, 'AUTH_CONTEXT_MISSING');
  }

  const { storeId } = storeParamsSchema.parse(req.params);
  const membership = req.context.storeAccess?.find((entry) => entry.storeId === storeId);

  if (!membership) {
    throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
  }

  req.context.storeId = storeId;
  req.context.role = membership.role;
  next();
};

export function requireRole(...allowedRoles: StoreRoleClaim[]): RequestHandler {
  return (req, _res, next) => {
    const role = req.context.role;
    if (!role) {
      throw new AppError('Store membership context missing', 500, 'STORE_CONTEXT_MISSING');
    }

    if (!allowedRoles.includes(role)) {
      throw new AppError('Insufficient store permissions', 403, 'FORBIDDEN');
    }

    next();
  };
}
