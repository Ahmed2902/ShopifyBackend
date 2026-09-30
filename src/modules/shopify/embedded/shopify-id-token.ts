import { jwtVerify } from 'jose';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { normalizeShopDomain } from '../shopify.utils.js';

export type ShopifyIdTokenContext = {
  shop: string;
  shopifyUserId: string;
  sessionId: string | null;
  tokenId: string | null;
};

function invalidSession(): AppError {
  return new AppError(
    'Shopify session is invalid or expired',
    401,
    'SHOPIFY_SESSION_INVALID',
  );
}

function urlHostname(value: unknown): string {
  if (typeof value !== 'string' || !value) throw invalidSession();
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    throw invalidSession();
  }
}

export async function verifyShopifyIdToken(token: string): Promise<ShopifyIdTokenContext> {
  if (!token) throw invalidSession();

  try {
    const { payload } = await jwtVerify(
      token,
      new TextEncoder().encode(env.SHOPIFY_CLIENT_SECRET),
      {
        algorithms: ['HS256'],
        audience: env.SHOPIFY_CLIENT_ID,
        clockTolerance: 5,
      },
    );

    const issuerHost = urlHostname(payload.iss);
    const destinationHost = urlHostname(payload.dest);
    if (issuerHost !== destinationHost) throw invalidSession();

    const shopifyUserId = typeof payload.sub === 'string' ? payload.sub.trim() : '';
    if (!shopifyUserId) throw invalidSession();

    return {
      shop: normalizeShopDomain(destinationHost),
      shopifyUserId,
      sessionId: typeof payload.sid === 'string' ? payload.sid : null,
      tokenId: typeof payload.jti === 'string' ? payload.jti : null,
    };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw invalidSession();
  }
}
