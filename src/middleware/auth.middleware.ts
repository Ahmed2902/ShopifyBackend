import type { RequestHandler } from 'express';
import { AppError } from '../errors/app-error.js';
import { verifyAccessToken } from '../modules/auth/auth.utils.js';

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const authorization = req.header('authorization');
  if (!authorization?.startsWith('Bearer ')) {
    throw new AppError('Authentication required', 401, 'UNAUTHORIZED');
  }

  const token = authorization.slice('Bearer '.length).trim();
  if (!token) throw new AppError('Authentication required', 401, 'UNAUTHORIZED');

  req.context.userId = await verifyAccessToken(token);
  next();
};
