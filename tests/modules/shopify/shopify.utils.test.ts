import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import {
  buildShopifyAuthorizationUrl,
  computeShopifyOAuthHmac,
  createShopifyOAuthContext,
  normalizeShopDomain,
  verifyShopifyOAuthContext,
  verifyShopifyOAuthHmac,
} from '../../../src/modules/shopify/shopify.utils.js';

describe('Shopify OAuth utilities', () => {
  it('accepts only canonical myshopify domains', () => {
    expect(normalizeShopDomain('Example-Store.myshopify.com')).toBe('example-store.myshopify.com');
    expect(normalizeShopDomain('https://example-store.myshopify.com/')).toBe(
      'example-store.myshopify.com',
    );
    expect(() => normalizeShopDomain('example-store.myshopify.com.evil.test')).toThrow(AppError);
    expect(() => normalizeShopDomain('https://example-store.myshopify.com/admin')).toThrow(AppError);
  });

  it('signs OAuth context and detects tampering', () => {
    const created = createShopifyOAuthContext(
      'b3ecf1b1-49bf-4ecf-982a-43db2f481cf0',
      'example-store.myshopify.com',
    );
    const verified = verifyShopifyOAuthContext(created.cookieValue);

    expect(verified.userId).toBe('b3ecf1b1-49bf-4ecf-982a-43db2f481cf0');
    expect(verified.shop).toBe('example-store.myshopify.com');
    expect(verified.state).toBe(created.state);

    const tampered = `${created.cookieValue.slice(0, -1)}${created.cookieValue.endsWith('A') ? 'B' : 'A'}`;
    expect(() => verifyShopifyOAuthContext(tampered)).toThrow(AppError);
  });

  it('builds an offline authorization URL with state and requested scopes', () => {
    const url = new URL(buildShopifyAuthorizationUrl('example-store.myshopify.com', 'random-state'));

    expect(url.origin).toBe('https://example-store.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('state')).toBe('random-state');
    expect(url.searchParams.get('grant_options[]')).toBeNull();
    expect(url.searchParams.get('scope')).toContain('read_products');
  });

  it('verifies callback HMAC and rejects modified parameters', () => {
    const params = new URLSearchParams({
      code: 'authorization-code',
      shop: 'example-store.myshopify.com',
      state: 'state-value',
      timestamp: String(Math.floor(Date.now() / 1000)),
    });
    params.set('hmac', computeShopifyOAuthHmac(params));

    expect(() => verifyShopifyOAuthHmac(params)).not.toThrow();
    params.set('shop', 'another-store.myshopify.com');
    expect(() => verifyShopifyOAuthHmac(params)).toThrow(AppError);
  });
});
