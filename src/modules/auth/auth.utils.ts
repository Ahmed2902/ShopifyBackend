import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { CookieOptions, Response } from 'express';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

// region Passwords
const SCRYPT_KEY_LENGTH = 64;
const PASSWORD_FORMAT = 'scrypt$v1';

function derivePasswordKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, SCRYPT_KEY_LENGTH, (error, derivedKey) => {
      if (error) return reject(error);
      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derivedKey = await derivePasswordKey(password, salt);
  return `${PASSWORD_FORMAT}$${salt}$${derivedKey.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, version, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || version !== 'v1' || !salt || !expected) return false;

  const expectedBuffer = Buffer.from(expected, 'base64url');
  const actualBuffer = await derivePasswordKey(password, salt);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}
// endregion

// region Tokens
const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const accessAudience = 'shopify-intelligence-web';

export async function issueAccessToken(userId: string): Promise<string> {
  return new SignJWT({ kind: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(accessAudience)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, {
      issuer: env.JWT_ISSUER,
      audience: accessAudience,
      algorithms: ['HS256'],
    });

    if (payload.kind !== 'access' || !payload.sub) throw new Error('Unexpected token payload');
    return payload.sub;
  } catch {
    throw new AppError('Invalid or expired access token', 401, 'UNAUTHORIZED');
  }
}

export function createRefreshToken(): string {
  return randomBytes(48).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
// endregion

// region Cookies and request metadata
export const REFRESH_COOKIE_NAME = 'refresh_token';

function refreshCookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
  };
}

export function setRefreshCookie(res: Response, token: string): void {
  res.cookie(REFRESH_COOKIE_NAME, token, {
    ...refreshCookieOptions(),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  });
}

export function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE_NAME, refreshCookieOptions());
}

export function sanitizeUserAgent(value: string | undefined): string | undefined {
  return value ? value.slice(0, 512) : undefined;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function refreshSessionExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}
// endregion
