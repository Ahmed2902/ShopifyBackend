import { describe, expect, it } from 'vitest';
import { assertShopifyProductionConfig } from '../../src/config/shopify-production.js';

const config = { SHOPIFY_APP_PRICING_ENABLED: true, LEGACY_MERCHANT_AUTH_ENABLED: false,
  SHOPIFY_PARTNER_ORG_ID: '123', SHOPIFY_PARTNER_API_ACCESS_TOKEN: 'test-token',
  SHOPIFY_PARTNER_APP_ID: 'gid://shopify/App/123', SHOPIFY_APP_HANDLE: 'stride',
  SHOPIFY_ESSENTIALS_PLAN_HANDLE: 'essentials', SHOPIFY_PRO_PLAN_HANDLE: 'pro',
  SHOPIFY_REDIRECT_URI: 'https://app.stride.test/api/shopify/callback' };
describe('Shopify production billing boundary', () => {
  it('accepts complete Shopify pricing configuration', () => {
    expect(() => assertShopifyProductionConfig(config, ['https://api.stride.test'])).not.toThrow();
  });
  it.each([{ SHOPIFY_APP_PRICING_ENABLED: false }, { LEGACY_MERCHANT_AUTH_ENABLED: true },
    { SHOPIFY_PARTNER_API_ACCESS_TOKEN: undefined }, { SHOPIFY_PRO_PLAN_HANDLE: 'essentials' }])('rejects a production configuration that bypasses Shopify (%j)', (override) => {
    expect(() => assertShopifyProductionConfig({ ...config, ...override }, ['https://api.stride.test'])).toThrow();
  });
  it.each(['http://api.stride.test', 'https://user:password@api.stride.test'])('rejects insecure production URLs (%s)', (url) => {
    expect(() => assertShopifyProductionConfig(config, [url])).toThrow();
  });
});
