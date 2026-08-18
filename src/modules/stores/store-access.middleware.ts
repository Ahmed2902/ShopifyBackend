import type { RequestHandler, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { getAuthUserId } from '../auth/auth.middleware.js';

interface StoreLocals {
  storeMembership?: {
    storeId: string;
    role: string;
  };
}

export function requireStoreRole(...allowedRoles: string[]): RequestHandler {
  return async (req, res, next) => {
    const storeId = z.string().uuid().parse(req.params.storeId);
    const membership = await prisma.storeMembership.findUnique({
      where: { userId_storeId: { userId: getAuthUserId(res), storeId } },
      select: { storeId: true, role: true },
    });

    if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
      throw new AppError('Insufficient store permissions', 403, 'FORBIDDEN');
    }

    (res.locals as StoreLocals).storeMembership = membership;
    next();
  };
}

export function getStoreId(res: Response): string {
  const storeId = (res.locals as StoreLocals).storeMembership?.storeId;
  if (!storeId) throw new AppError('Store context missing', 500, 'STORE_CONTEXT_MISSING');
  return storeId;
}
