import { createHash, randomBytes } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';

const accessSecret = new TextEncoder().encode(env.JWT_ACCESS_SECRET);
const audience = 'shopify-intelligence-web';

export async function issueAccessToken(userId: string): Promise<string> {
  return new SignJWT({ kind: 'access' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(userId)
    .setIssuer(env.JWT_ISSUER)
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<string> {
  try {
    const { payload } = await jwtVerify(token, accessSecret, {
      issuer: env.JWT_ISSUER,
      audience,
      algorithms: ['HS256'],
    });

    if (payload.kind !== 'access' || !payload.sub) {
      throw new Error('Unexpected token payload');
    }

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
