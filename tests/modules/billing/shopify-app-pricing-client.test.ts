import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../src/config/env.js';
import { ShopifyAppPricingClient } from '../../../src/modules/billing/shopify-app-pricing.client.js';

const original = { ...env };
beforeEach(() => {
  Object.assign(env, { SHOPIFY_PARTNER_ORG_ID: '123', SHOPIFY_PARTNER_API_ACCESS_TOKEN: 'test-token',
    SHOPIFY_PARTNER_APP_ID: 'gid://shopify/App/123', SHOPIFY_APP_HANDLE: 'stride',
    SHOPIFY_ESSENTIALS_PLAN_HANDLE: 'essentials', SHOPIFY_PRO_PLAN_HANDLE: 'pro' });
});
afterEach(() => { Object.assign(env, original); vi.unstubAllGlobals(); });

describe('Shopify App Pricing response boundary', () => {
  it('recognizes only an explicit null as no active subscription', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ data: { activeSubscription: null } })));
    await expect(new ShopifyAppPricingClient().activeSubscription('gid://shopify/Shop/123')).resolves.toBeNull();
  });
  it.each([null, {}, { data: {} }, { data: null }, { data: { activeSubscription: { items: [] } } },
    { errors: [{ message: 'Unauthorized' }] }])('rejects unavailable or malformed data instead of recording a cancellation (%j)', async (payload) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json(payload)));
    await expect(new ShopifyAppPricingClient().activeSubscription('gid://shopify/Shop/123')).rejects.toMatchObject({ code: 'SHOPIFY_BILLING_UNAVAILABLE', statusCode: 503 });
  });
});
