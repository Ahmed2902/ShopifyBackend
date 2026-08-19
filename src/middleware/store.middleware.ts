import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import { StoreRepository } from '../modules/stores/store.repository.js';
import { storeParamsSchema } from '../modules/stores/store.schema.js';

export type StoreRole = 'OWNER' | 'ADMIN' | 'MEMBER';

const repository = new StoreRepository();

export const requireStoreMembership: RequestHandler = async (req, _res, next) => {
  const userId = req.context.userId;
  if (!userId) {
    throw new AppError('Authentication context missing', 500, 'AUTH_CONTEXT_MISSING');
  }

  const { storeId } = storeParamsSchema.parse(req.params);
  const membership = await repository.findMembership(userId, storeId);

  if (!membership) {
    throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
  }

  req.context.storeId = storeId;
  req.context.role = membership.role;
  next();
};

export function requireRole(...allowedRoles: StoreRole[]): RequestHandler {
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
