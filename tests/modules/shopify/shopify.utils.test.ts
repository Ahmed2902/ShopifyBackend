import { describe, expect, it } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import {
  buildShopifyAuthorizationUrl,
  buildShopifySuccessRedirect,
  calculateShopifyThrottleDelayMs,
  computeShopifyOAuthHmac,
  createShopifyOAuthContext,
  normalizeShopDomain,
  paginateShopifyConnection,
  parseRetryAfterMs,
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

  it('makes OAuth state self-verifying and detects tampering without a callback cookie', () => {
    const created = createShopifyOAuthContext(
      'b3ecf1b1-49bf-4ecf-982a-43db2f481cf0',
      'example-store.myshopify.com',
    );
    const verified = verifyShopifyOAuthContext(created.state);

    expect(verified.userId).toBe('b3ecf1b1-49bf-4ecf-982a-43db2f481cf0');
    expect(verified.shop).toBe('example-store.myshopify.com');
    expect(verified.state.length).toBeGreaterThanOrEqual(32);
    expect(created.cookieValue).toBe(created.state);

    const tampered = `${created.state.slice(0, -1)}${created.state.endsWith('A') ? 'B' : 'A'}`;
    expect(() => verifyShopifyOAuthContext(tampered)).toThrow(AppError);
  });

  it('builds an offline authorization URL with state, requested scopes, and the configured callback', () => {
    const url = new URL(buildShopifyAuthorizationUrl('example-store.myshopify.com', 'random-state'));

    expect(url.origin).toBe('https://example-store.myshopify.com');
    expect(url.pathname).toBe('/admin/oauth/authorize');
    expect(url.searchParams.get('state')).toBe('random-state');
    expect(url.searchParams.get('grant_options[]')).toBeNull();
    expect(url.searchParams.get('scope')).toContain('read_products');
    expect(url.searchParams.get('redirect_uri')).toBe(process.env.SHOPIFY_REDIRECT_URI);
  });

  it('returns OAuth installs to the real integrations page', () => {
    const redirect = new URL(
      buildShopifySuccessRedirect(
        'b3ecf1b1-49bf-4ecf-982a-43db2f481cf0',
        'example-store.myshopify.com',
      ),
    );

    expect(redirect.pathname).toBe('/app/integrations');
    expect(redirect.searchParams.get('shopify')).toBe('connected');
    expect(redirect.searchParams.get('storeId')).toBe('b3ecf1b1-49bf-4ecf-982a-43db2f481cf0');
    expect(redirect.searchParams.get('shop')).toBe('example-store.myshopify.com');
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

describe('Shopify Admin API utilities', () => {
  it('converts retry-after seconds and calculates throttle recovery delay', () => {
    expect(parseRetryAfterMs('1.5')).toBe(1500);
    expect(parseRetryAfterMs('invalid')).toBeNull();

    expect(
      calculateShopifyThrottleDelayMs({
        requestedQueryCost: 100,
        actualQueryCost: 90,
        throttleStatus: {
          maximumAvailable: 1000,
          currentlyAvailable: 50,
          restoreRate: 50,
        },
      }),
    ).toBe(1100);
  });

  it('paginates forward with Shopify end cursors', async () => {
    const requestedCursors: Array<string | null> = [];
    const pages: number[][] = [];

    for await (const nodes of paginateShopifyConnection(async (cursor) => {
      requestedCursors.push(cursor);
      return cursor === null
        ? { nodes: [1, 2], pageInfo: { hasNextPage: true, endCursor: 'cursor-1' } }
        : { nodes: [3], pageInfo: { hasNextPage: false, endCursor: 'cursor-2' } };
    })) {
      pages.push(nodes);
    }

    expect(requestedCursors).toEqual([null, 'cursor-1']);
    expect(pages).toEqual([[1, 2], [3]]);
  });

  it('rejects a pagination loop instead of requesting forever', async () => {
    const iterator = paginateShopifyConnection(async (cursor) => ({
      nodes: [1],
      pageInfo: { hasNextPage: true, endCursor: cursor ?? 'cursor-1' },
    }));

    await iterator.next();
    await iterator.next();
    await expect(iterator.next()).rejects.toThrow(AppError);
  });
});