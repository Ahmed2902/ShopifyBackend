import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
const configuration = {
  SHOPIFY_APP_PRICING_ENABLED: 'true', LEGACY_MERCHANT_AUTH_ENABLED: 'false',
  SHOPIFY_CLIENT_ID: 'client', SHOPIFY_CLIENT_SECRET: 'secret', SHOPIFY_PARTNER_ORG_ID: '123',
  SHOPIFY_PARTNER_API_ACCESS_TOKEN: 'token', SHOPIFY_PARTNER_APP_ID: 'gid://shopify/App/1',
  SHOPIFY_APP_HANDLE: 'stride', SHOPIFY_ESSENTIALS_PLAN_HANDLE: 'essentials', SHOPIFY_PRO_PLAN_HANDLE: 'pro',
  SHOPIFY_SUPPORT_EMAIL: 'support@stridecommerce.io', SHOPIFY_REVIEW_CONTACT_EMAIL: 'review@stridecommerce.io',
  SHOPIFY_EMERGENCY_CONTACT_EMAIL: 'emergency@stridecommerce.io', SHOPIFY_PRIVACY_POLICY_URL: 'https://app.stridecommerce.io/privacy',
  SHOPIFY_TERMS_URL: 'https://app.stridecommerce.io/terms', SHOPIFY_APP_URL: 'https://app.stridecommerce.io/app',
  APP_URL: 'https://api.stridecommerce.io', FRONTEND_URL: 'https://app.stridecommerce.io', CORS_ORIGIN: 'https://app.stridecommerce.io',
  SHOPIFY_REDIRECT_URI: 'https://app.stridecommerce.io/api/shopify/callback', PIXEL_COLLECTOR_URL: 'https://api.stridecommerce.io/v1/pixel/events',
  SHOPIFY_SCOPES: 'read_products,read_inventory,read_locations,read_orders,read_pixels,write_pixels,read_customer_events',
};
function check(overrides: Record<string, string> = {}) {
  return spawnSync(process.execPath, ['scripts/check-shopify-app-store-readiness.mjs'], { encoding: 'utf8', env: { ...process.env, ...configuration, ...overrides } });
}
describe('Shopify submission configuration gate', () => {
  it('accepts the selected Shopify-native implementation without an obsolete auth flag', () => { expect(check().status).toBe(0); });
  it('rejects missing Pixel scopes and the actual runtime HTTP origin', () => {
    const result = check({ SHOPIFY_SCOPES: 'read_products,read_inventory,read_locations,read_orders', APP_URL: 'http://localhost:3001' });
    expect(result.status).toBe(1); expect(result.stderr).toContain('write_pixels'); expect(result.stderr).toContain('read_customer_events'); expect(result.stderr).toContain('APP_URL must use https');
  });
});
