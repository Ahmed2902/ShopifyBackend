import type { RequestHandler, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { verifyAccessToken } from './tokens.js';

interface AuthLocals {
  auth?: { userId: string };
}

export const requireAuth: RequestHandler = async (req, res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');

  const userId = await verifyAccessToken(token);
  (res.locals as AuthLocals).auth = { userId };
  next();
};

export function getAuthUserId(res: Response): string {
  const userId = (res.locals as AuthLocals).auth?.userId;
  if (!userId) throw new AppError('Authentication context missing', 500, 'AUTH_CONTEXT_MISSING');
  return userId;
}
