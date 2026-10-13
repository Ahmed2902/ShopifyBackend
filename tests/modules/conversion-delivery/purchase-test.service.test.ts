import { beforeEach, describe, expect, it, vi } from 'vitest';
const { development, store, order, find, enqueue, destination, delivery } = vi.hoisted(() => ({ development: vi.fn(), store: vi.fn(), order: vi.fn(), find: vi.fn(), enqueue: vi.fn(), destination: vi.fn(), delivery: vi.fn() }));
vi.mock('../../../src/modules/billing/shopify-development-store.js', () => ({ verifyShopifyDevelopmentStore: development }));
vi.mock('../../../src/modules/billing/billing.service.js', () => ({ billingService: { requireAdProviderReadOnly: vi.fn() } }));
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: { store: { findUnique: store }, order: { findFirst: order }, conversionDelivery: { findUnique: delivery } } }));
vi.mock('../../../src/modules/conversion-delivery/conversion-delivery.repository.js', () => ({ ConversionDeliveryRepository: class { findDestinationWithSecret = destination; findPurchaseCandidates = find; enqueue = enqueue; } }));
import { queuePurchaseTest } from '../../../src/modules/conversion-delivery/purchase-test.service.js';
import { decryptSecret } from '../../../src/modules/integrations/integration.utils.js';
beforeEach(() => { vi.clearAllMocks(); development.mockResolvedValue(true); store.mockResolvedValue({ shopifyShopId: 'gid://shopify/Shop/1' }); order.mockResolvedValue({ id: 'order' });
  destination.mockResolvedValue({ provider: 'META', status: 'ACTIVE' }); enqueue.mockResolvedValue({ created: true }); delivery.mockResolvedValue({ id: 'test', status: 'PENDING' });
  find.mockResolvedValue([{ storeId: 'store', sourceEventId: 'source', shopifyOrderId: 'gid://shopify/Order/1', value: '15', currencyCode: 'USD', eventAt: new Date(), metaClickId: null }]); });
describe('development-store purchase test authorization', () => {
  it('blocks live stores before selecting an order or sending anything', async () => {
    development.mockResolvedValue(false);
    await expect(queuePurchaseTest('store', 'destination', 'order', 'TEST123')).rejects.toMatchObject({ code: 'TRACKING_TEST_DEV_STORE_REQUIRED' });
    expect(order).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  });
  it('requires an actual test-payment order from the authorized store', async () => {
    order.mockResolvedValue(null);
    await expect(queuePurchaseTest('store', 'destination', 'other-order', 'TEST123')).rejects.toMatchObject({ code: 'TRACKING_TEST_ORDER_NOT_FOUND' });
    expect(order).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'other-order', storeId: 'store', isTest: true, cancelledAt: null } }));
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('requires a retained permitted checkout, not only an existing order', async () => {
    find.mockResolvedValue([]);
    await expect(queuePurchaseTest('store', 'destination', 'order', 'TEST123')).rejects.toMatchObject({ code: 'TRACKING_TEST_CHECKOUT_REQUIRED' });
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('queues the canonical purchase and stores the test code encrypted with expiry', async () => {
    await queuePurchaseTest('store', 'destination', 'order', 'TEST123');
    const queued = enqueue.mock.calls[0]![0];
    expect(queued).toMatchObject({ isTestDelivery: true, sourceOrderId: 'order', sourceEventId: 'source', value: '15', currencyCode: 'USD' });
    expect(decryptSecret(queued.testCodeCiphertext)).toBe('TEST123'); expect(queued.testExpiresAt).toBeInstanceOf(Date);
    expect(find).toHaveBeenCalledWith(1, 'order', true, 'store');
  });
  it('gives each explicitly requested checkout test a new event ID while keeping the same Shopify order', async () => {
    await queuePurchaseTest('store', 'destination', 'order', 'TEST123');
    await queuePurchaseTest('store', 'destination', 'order', 'TEST123');
    expect(enqueue).toHaveBeenCalledTimes(2);
    const first = enqueue.mock.calls[0]![0];
    const second = enqueue.mock.calls[1]![0];
    expect(first.eventKey).not.toBe(second.eventKey);
    expect(first.sourceOrderId).toBe('order');
    expect(second.sourceOrderId).toBe('order');
    expect(first.shopifyOrderId).toBe(second.shopifyOrderId);
    expect(delivery).toHaveBeenLastCalledWith(expect.objectContaining({
      where: { destinationId_sourceOrderId_eventName: {
        destinationId: 'destination', sourceOrderId: 'order', eventName: 'PURCHASE',
      } },
    }));
  });
  it('requires Meta/TikTok test codes but lets Google queue validation only', async () => {
    await expect(queuePurchaseTest('store', 'destination', 'order')).rejects.toMatchObject({ code: 'TRACKING_TEST_CODE_REQUIRED' });
    destination.mockResolvedValue({ provider: 'GOOGLE_ADS', status: 'ACTIVE' });
    await expect(queuePurchaseTest('store', 'destination', 'order')).resolves.toMatchObject({ testOnly: true, googleValidationOnly: true });
    expect(enqueue.mock.calls[0]![0]).toMatchObject({ isTestDelivery: true, testCodeCiphertext: null });
  });
});
