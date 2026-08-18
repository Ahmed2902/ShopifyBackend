import { Router } from 'express';
import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { clearRefreshCookie, REFRESH_COOKIE_NAME, setRefreshCookie } from './auth.cookies.js';
import { getAuthUserId, requireAuth } from './auth.middleware.js';
import {
  loginUser,
  registerUser,
  revokeRefreshSession,
  rotateRefreshSession,
} from './auth.service.js';

const registerSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(10).max(200),
  name: z.string().trim().min(1).max(100).optional(),
});

const loginSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
});

export const authRouter = Router();

function userAgent(value: string | undefined) {
  return value ? { userAgent: value.slice(0, 512) } : {};
}

authRouter.post('/register', async (req, res) => {
  const input = registerSchema.parse(req.body);
  const result = await registerUser(input, userAgent(req.get('user-agent')));
  setRefreshCookie(res, result.refreshToken);
  res.status(201).json({ user: result.user, accessToken: result.accessToken });
});

authRouter.post('/login', async (req, res) => {
  const input = loginSchema.parse(req.body);
  const result = await loginUser(input, userAgent(req.get('user-agent')));
  setRefreshCookie(res, result.refreshToken);
  res.status(200).json({ user: result.user, accessToken: result.accessToken });
});

authRouter.post('/refresh', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  if (!refreshToken) throw new AppError('Refresh session required', 401, 'INVALID_SESSION');

  const result = await rotateRefreshSession(refreshToken, userAgent(req.get('user-agent')));
  setRefreshCookie(res, result.refreshToken);
  res.status(200).json({ user: result.user, accessToken: result.accessToken });
});

authRouter.post('/logout', async (req, res) => {
  const refreshToken = req.cookies?.[REFRESH_COOKIE_NAME] as string | undefined;
  await revokeRefreshSession(refreshToken);
  clearRefreshCookie(res);
  res.status(204).send();
});

authRouter.get('/me', requireAuth, async (_req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: getAuthUserId(res) },
    select: { id: true, email: true, name: true, emailVerifiedAt: true, createdAt: true },
  });

  if (!user) throw new AppError('User not found', 401, 'UNAUTHORIZED');
  res.status(200).json({ user });
});
