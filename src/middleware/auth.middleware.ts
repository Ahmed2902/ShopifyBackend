import type { RequestHandler, Response } from 'express';
import { AppError } from '../errors/app-error.js';
import { verifyAccessToken } from '../modules/auth/auth.utils.js';
import { prisma } from '../lib/prisma.js';

interface AuthLocals {
  auth?: { userId: string };
  storeRole?: string;
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');

  (res.locals as AuthLocals).auth = { userId: await verifyAccessToken(token) };
  next();
};

export function getAuthUserId(res: Response): string {
  const userId = (res.locals as AuthLocals).auth?.userId;
  if (!userId) throw new AppError('Authentication context missing', 500, 'AUTH_CONTEXT_MISSING');
  return userId;
}

export function getStoreRole(res: Response): string {
  const role = (res.locals as AuthLocals).storeRole;
  if (!role) throw new AppError('Store role context missing', 500, 'STORE_ROLE_CONTEXT_MISSING');
  return role;
}

export function requireRole(allowedRoles: string[] = []): RequestHandler {
  return async (req, res, next) => {
    const storeId = req.params.storeId;
    if (typeof storeId !== 'string' || !storeId) {
      throw new AppError('Store id is required', 400, 'STORE_ID_REQUIRED');
    }

    const membership = await prisma.storeMembership.findUnique({
      where: { userId_storeId: { userId: getAuthUserId(res), storeId } },
      select: { role: true },
    });
    if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
      throw new AppError('Insufficient store permissions', 403, 'FORBIDDEN');
    }

    (res.locals as AuthLocals).storeRole = membership.role;
    next();
  };
}
