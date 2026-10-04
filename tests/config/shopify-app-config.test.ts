import { describe, expect, it } from 'vitest';
import { renderShopifyAppConfig } from '../../scripts/shopify-app-config.mjs';

const config = { SHOPIFY_CLIENT_ID: 'test-client', APP_URL: 'https://api.stride.test',
  FRONTEND_URL: 'https://app.stride.test', SHOPIFY_APP_URL: 'https://app.stride.test/app/overview',
  SHOPIFY_REDIRECT_URI: 'https://app.stride.test/api/shopify/callback',
  SHOPIFY_SCOPES: 'read_products,read_inventory,read_locations,read_orders,read_pixels,write_pixels,read_customer_events',
  SHOPIFY_CLIENT_SECRET: 'secret-that-must-not-be-rendered' };
describe('Shopify app deployment configuration', () => {
  it('targets the embedded frontend, backend compliance webhooks and managed installation without exposing secrets', () => {
    const result = renderShopifyAppConfig(config);
    expect(result).toContain('application_url = "https://app.stride.test/app/overview"');
    expect(result).toContain('use_legacy_install_flow = false');
    expect(result).toContain('name = "Metrico"');
    expect(result).toContain('compliance_topics = ["customers/data_request", "customers/redact", "shop/redact"]');
    expect(result).toContain('https://api.stride.test/v1/integrations/shopify/webhooks');
    expect(result).not.toContain(config.SHOPIFY_CLIENT_SECRET);
  });
  it.each([{ SHOPIFY_APP_URL: 'https://app.stride.test/' }, { SHOPIFY_REDIRECT_URI: 'https://wrong.test/callback' },
    { SHOPIFY_SCOPES: 'read_customers' }])('rejects configurations that break installation or over-request access (%j)', (override) => {
    expect(() => renderShopifyAppConfig({ ...config, ...override })).toThrow();
  });
});
