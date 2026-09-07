import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import { StoreRepository } from '../modules/stores/store.repository.js';
import { storeParamsSchema } from '../modules/stores/store.schema.js';
import type { StoreRoleClaim } from '../types/auth.js';

type StoreMembershipLookup = Pick<StoreRepository, 'findMembership'>;

export function createRequireStoreMembership(repository: StoreMembershipLookup): RequestHandler {
  return async (req, _res, next) => {
    if (!req.context.userId) {
      throw new AppError('Authentication context missing', 500, 'AUTH_CONTEXT_MISSING');
    }

    const { storeId } = storeParamsSchema.parse(req.params);
    // Access-token store claims are intentionally not authoritative here. Membership and role can
    // change while a short-lived access token is still valid, so every protected store request
    // resolves the current database row before exposing tenant data or privileged mutations.
    const membership = await repository.findMembership(req.context.userId, storeId);
    if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    req.context.storeId = storeId;
    req.context.role = membership.role;
    next();
  };
}

export const requireStoreMembership = createRequireStoreMembership(new StoreRepository());

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
