import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeliveryClaim } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';
import { enrichConversionSignal, sameCheckoutProof, shopifyOrderMatchingQuery } from '../../../src/modules/conversion-delivery/signal-enrichment.service.js';
import { ConversionConsentWithdrawnError } from '../../../src/modules/conversion-delivery/providers/conversion-provider.error.js';
import { metaUserData, sha256, tiktokUserData } from '../../../src/modules/conversion-delivery/matching.js';

const mocks = vi.hoisted(() => ({
  event: vi.fn(), store: vi.fn(), graphql: vi.fn(), token: vi.fn(),
  settings: { SHOPIFY_ENHANCED_MATCHING_APPROVED: true, SHOPIFY_ENHANCED_MATCHING_FIELDS: ['email', 'client_ip'] },
}));
vi.mock('../../../src/config/env.js', () => ({ env: mocks.settings }));
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: {
  storefrontEvent: { findFirst: mocks.event }, store: { findUnique: mocks.store },
} }));
vi.mock('../../../src/modules/shopify/shopify.repository.js', () => ({ ShopifyRepository: class {} }));
vi.mock('../../../src/modules/shopify/shared/shopify-api.service.js', () => ({
  ShopifyApiService: class { requestAdminGraphql = mocks.graphql; },
}));
vi.mock('../../../src/modules/shopify/shared/shopify-auth.service.js', () => ({
  ShopifyAuthService: class { resolveAccessToken = mocks.token; },
}));
vi.mock('../../../src/modules/integrations/integration.utils.js', () => ({
  decryptSecret: (value: string) => value, encryptSecret: (value: string) => value,
}));
const generation = new Date('2026-10-03T00:00:00Z');
function claim(): DeliveryClaim {
  return { storeId: 'store-a', sourceOrderId: 'order-a', sourceEventId: 'event-a',
    sourceGenerationAt: generation, shopifyOrderId: 'gid://shopify/Order/1',
    destination: { configJson: { enhancedMatching: true } } } as DeliveryClaim;
}
describe('canonical Shopify matching authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings.SHOPIFY_ENHANCED_MATCHING_APPROVED = true;
    mocks.settings.SHOPIFY_ENHANCED_MATCHING_FIELDS = ['email', 'client_ip'];
    mocks.event.mockResolvedValue({ shopifyCheckoutToken: 'high-entropy-checkout-proof' });
    mocks.store.mockResolvedValue({ myshopifyDomain: 'store-a.myshopify.com',
      signalIdentityKey: { secretCiphertext: 'store-only-secret' },
      shopifyConnection: { id: 'connection-a', status: 'ACTIVE', installedAt: generation,
        apiVersion: '2026-10', scopes: ['read_orders'] } });
    mocks.token.mockResolvedValue('shopify-token');
    mocks.graphql.mockReset()
      .mockResolvedValueOnce({ order: { id: 'gid://shopify/Order/1', checkoutToken: 'high-entropy-checkout-proof' } })
      .mockResolvedValueOnce({ order: { id: 'gid://shopify/Order/1', email: ' Buyer@Example.com ', clientIp: '203.0.113.9' } });
  });
  it('requires exact nonempty checkout proof, including unequal lengths', () => {
    expect(sameCheckoutProof('abc', 'abc')).toBe(true);
    expect(sameCheckoutProof('abc', 'abcd')).toBe(false);
    expect(sameCheckoutProof('', '')).toBe(false);
    expect(sameCheckoutProof(null, 'abc')).toBe(false);
  });
  it('requests only explicitly approved fields and ignores arbitrary query fragments', () => {
    const query = shopifyOrderMatchingQuery(['email', 'client_ip', 'email } mutation {']);
    expect(query).toContain('email');
    expect(query).toContain('clientIp');
    expect(query).not.toMatch(/phone|billingAddress|customer|mutation/);
    const address = shopifyOrderMatchingQuery(['address']);
    expect(address).toContain('shippingAddress');
    expect(address).not.toMatch(/firstName|lastName|email|phone/);
  });
  it('does not request protected fields when the collector merely knows an order ID', async () => {
    mocks.graphql.mockReset().mockResolvedValue({ order: { id: 'gid://shopify/Order/1', checkoutToken: 'different-checkout' } });
    const delivery = claim();
    expect(await enrichConversionSignal(delivery, async () => undefined)).toEqual({});
    expect(delivery.matchingReasonCode).toBe('CHECKOUT_PROOF_UNAVAILABLE');
    expect(mocks.graphql).toHaveBeenCalledOnce();
    expect(mocks.graphql.mock.calls[0]![0].query).not.toMatch(/email|phone|clientIp|customer/);
  });
  it('does not request protected fields without observed proof or on an old API', async () => {
    mocks.event.mockResolvedValueOnce({ shopifyCheckoutToken: null });
    expect(await enrichConversionSignal(claim())).toEqual({});
    expect(mocks.graphql).not.toHaveBeenCalled();
    mocks.store.mockResolvedValueOnce({ myshopifyDomain: 'store-a.myshopify.com',
      shopifyConnection: { status: 'ACTIVE', installedAt: generation, apiVersion: '2026-04', scopes: ['read_orders'] } });
    const delivery = claim();
    expect(await enrichConversionSignal(delivery)).toEqual({});
    expect(delivery.matchingReasonCode).toBe('SHOPIFY_MATCHING_API_UPGRADE_REQUIRED');
    expect(mocks.token).not.toHaveBeenCalled();
  });
  it('rechecks permission after OAuth and again between proof and protected access', async () => {
    const denied = new ConversionConsentWithdrawnError();
    const check = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(denied);
    await expect(enrichConversionSignal(claim(), check)).rejects.toBe(denied);
    expect(check).toHaveBeenCalledTimes(2);
    expect(mocks.graphql).toHaveBeenCalledOnce();
  });
  it('uses approved canonical IP in Meta/TikTok, and never persists raw customer data', async () => {
    const check = vi.fn().mockResolvedValue(undefined);
    const evidence = await enrichConversionSignal(claim(), check);
    expect(evidence.meta?.em).toEqual([sha256('buyer@example.com')]);
    expect(JSON.stringify(evidence)).not.toContain('Buyer@');
    expect(metaUserData(evidence, null, generation).client_ip_address).toBe('203.0.113.9');
    expect(tiktokUserData(evidence, null).ip).toBe('203.0.113.9');
    expect(check).toHaveBeenCalledTimes(2);
    expect(mocks.graphql.mock.calls[1]![0].query).not.toMatch(/phone|customer|billingAddress/);
  });
  it('keeps protected matching disabled without the global approval or merchant opt-in', async () => {
    mocks.settings.SHOPIFY_ENHANCED_MATCHING_APPROVED = false;
    expect(await enrichConversionSignal(claim())).toEqual({});
    mocks.settings.SHOPIFY_ENHANCED_MATCHING_APPROVED = true;
    const delivery = claim(); delivery.destination.configJson = { enhancedMatching: false };
    expect(await enrichConversionSignal(delivery)).toEqual({});
    expect(mocks.store).not.toHaveBeenCalled();
    expect(mocks.graphql).not.toHaveBeenCalled();
  });
  it('omits an invalid canonical IP instead of inventing a value', async () => {
    mocks.graphql.mockReset()
      .mockResolvedValueOnce({ order: { id: 'gid://shopify/Order/1', checkoutToken: 'high-entropy-checkout-proof' } })
      .mockResolvedValueOnce({ order: { id: 'gid://shopify/Order/1', clientIp: 'not-an-ip' } });
    expect(await enrichConversionSignal(claim())).toEqual({});
  });
});
