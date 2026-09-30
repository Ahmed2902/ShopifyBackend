import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { env } from '../../../src/config/env.js';
import { verifyShopifyIdToken } from '../../../src/modules/shopify/embedded/shopify-id-token.js';

const secret = new TextEncoder().encode(env.SHOPIFY_CLIENT_SECRET);

async function token(
  overrides: Record<string, unknown> = {},
  options: { audience?: string; expiresAt?: number } = {},
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    dest: 'https://example-shop.myshopify.com',
    sid: 'session-1',
    jti: 'token-1',
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('https://example-shop.myshopify.com/admin')
    .setAudience(options.audience ?? env.SHOPIFY_CLIENT_ID)
    .setSubject('42')
    .setIssuedAt(now)
    .setNotBefore(now - 5)
    .setExpirationTime(options.expiresAt ?? now + 60)
    .sign(secret);
}

describe('verifyShopifyIdToken', () => {
  it('accepts a valid App Bridge ID token and returns the trusted shop/user identity', async () => {
    await expect(verifyShopifyIdToken(await token())).resolves.toEqual({
      shop: 'example-shop.myshopify.com',
      shopifyUserId: '42',
      sessionId: 'session-1',
      tokenId: 'token-1',
    });
  });

  it('rejects a token for a different app audience', async () => {
    await expect(token({}, { audience: 'another-app' }).then(verifyShopifyIdToken)).rejects.toMatchObject({
      code: 'SHOPIFY_SESSION_INVALID',
      statusCode: 401,
    });
  });

  it('rejects mismatched issuer and destination shops', async () => {
    await expect(
      token({ dest: 'https://other-shop.myshopify.com' }).then(verifyShopifyIdToken),
    ).rejects.toMatchObject({ code: 'SHOPIFY_SESSION_INVALID', statusCode: 401 });
  });

  it('rejects expired tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(token({}, { expiresAt: now - 30 }).then(verifyShopifyIdToken)).rejects.toMatchObject({
      code: 'SHOPIFY_SESSION_INVALID',
      statusCode: 401,
    });
  });
});
