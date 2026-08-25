import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Request, RequestHandler } from 'express';
import { env } from '../config/env.js';
import { AppError } from '../errors/app-error.js';

export const CSRF_COOKIE_NAME = 'csrf_token';
export const CSRF_HEADER_NAME = 'x-csrf-token';
const CSRF_TTL_MS = 2 * 60 * 60 * 1_000;
const FRONTEND_ORIGIN = new URL(env.CORS_ORIGIN).origin;

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function trustedOrigin(req: Request): boolean {
  const source = req.get('origin') ?? req.get('referer');
  try {
    return Boolean(source && new URL(source).origin === FRONTEND_ORIGIN);
  } catch {
    return false;
  }
}

function cookieOptions(): CookieOptions {
  const production = env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    secure: production,
    sameSite: production ? 'none' : 'lax',
    // The token is issued by /v1/auth but is verified on protected mutations
    // throughout the API, so the cookie must be available to all API routes.
    path: '/',
    maxAge: CSRF_TTL_MS,
  };
}

export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  if (trustedOrigin(req)) return next();
  return next(new AppError('Invalid request origin', 403, 'CSRF_INVALID'));
};

export const issueCsrfToken: RequestHandler = (_req, res) => {
  const csrfToken = randomBytes(32).toString('base64url');
  res.cookie(CSRF_COOKIE_NAME, csrfToken, cookieOptions());
  res.set('Cache-Control', 'no-store');
  res.status(200).json({ csrfToken });
};

export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (!trustedOrigin(req)) {
    return next(new AppError('Invalid request origin', 403, 'CSRF_INVALID'));
  }

  const header = req.get(CSRF_HEADER_NAME);
  const cookie = req.cookies?.[CSRF_COOKIE_NAME];
  if (!header || typeof cookie !== 'string' || !safeEqual(header, cookie)) {
    return next(new AppError('CSRF token required', 403, 'CSRF_INVALID'));
  }

  return next();
};
