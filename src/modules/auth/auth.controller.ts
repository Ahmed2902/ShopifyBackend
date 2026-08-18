import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { getAuthUserId } from './auth.middleware.js';
import {
  getCurrentUser,
  loginUser,
  registerUser,
  revokeRefreshSession,
  rotateRefreshSession,
} from './auth.service.js';
import {
  clearRefreshCookie,
  REFRESH_COOKIE_NAME,
  sanitizeUserAgent,
  setRefreshCookie,
} from './auth.utils.js';

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

function sessionMetadata(req: Request) {
  return { userAgent: sanitizeUserAgent(req.get('user-agent')) };
}

export const authController = {
  async register(req: Request, res: Response) {
    const input = registerSchema.parse(req.body);
    const result = await registerUser(input, sessionMetadata(req));
    setRefreshCookie(res, result.refreshToken);
    res.status(201).json({ user: result.user, accessToken: result.accessToken });
  },

  async login(req: Request, res: Response) {
    const input = loginSchema.parse(req.body);
    const result = await loginUser(input, sessionMetadata(req));
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ user: result.user, accessToken: result.accessToken });
  },

  async refresh(req: Request, res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    if (!refreshToken) throw new AppError('Refresh session required', 401, 'INVALID_SESSION');

    const result = await rotateRefreshSession(refreshToken, sessionMetadata(req));
    setRefreshCookie(res, result.refreshToken);
    res.status(200).json({ user: result.user, accessToken: result.accessToken });
  },

  async logout(req: Request, res: Response) {
    const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
    await revokeRefreshSession(refreshToken);
    clearRefreshCookie(res);
    res.status(204).send();
  },

  async me(_req: Request, res: Response) {
    const user = await getCurrentUser(getAuthUserId(res));
    res.status(200).json({ user });
  },
};
