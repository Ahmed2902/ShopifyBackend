import { beforeEach, describe, expect, it, vi } from 'vitest';
const { createMany, findUnique, updateMany } = vi.hoisted(() => ({
  createMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(),
}));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { conversionDelivery: { createMany, findUnique, updateMany } },
}));
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';

const input = () => ({
  storeId: 'store-1', destinationId: 'dest-1', provider: 'TIKTOK' as const,
  sourceOrderId: 'order-1', sourceEventId: 'event-1',
  shopifyOrderId: 'gid://shopify/Order/123', eventKey: 'stride:event:new-attempt',
  eventAt: new Date(), value: '15.00', currencyCode: 'USD',
  clickId: null, attributionEventAt: null,
  eventSourceUrl: 'https://example.myshopify.com/',
  isTestDelivery: true, testCodeCiphertext: 'encrypted-code',
  testExpiresAt: new Date(Date.now() + 3600_000),
});

beforeEach(() => {
  vi.resetAllMocks();
  createMany.mockResolvedValue({ count: 0 });
  updateMany.mockResolvedValue({ count: 1 });
  findUnique.mockResolvedValue({
    id: 'old-attempt', storeId: 'store-1', provider: 'TIKTOK',
    isTestDelivery: true, status: 'DEAD',
  });
});

describe('isolated checkout test retries', () => {
  it('inserts a new test when there is no existing order attempt', async () => {
    createMany.mockResolvedValue({ count: 1 });
    expect(await new ConversionDeliveryRepository().enqueue(input())).toEqual({ created: true });
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('rearms a terminal test with a new event ID, resets error and encrypted test code', async () => {
    expect(await new ConversionDeliveryRepository().enqueue(input())).toEqual({ created: true });
    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'old-attempt', isTestDelivery: true,
        status: { in: ['DEAD', 'SKIPPED', 'DELIVERED'] },
      }),
      data: expect.objectContaining({
        eventKey: 'stride:event:new-attempt', status: 'PENDING',
        attempts: 0, providerRequestId: null, testCodeCiphertext: 'encrypted-code',
        lastError: null, reasonCode: null,
      }),
    }));
  });
  it('never re-arms live deliveries or records belonging to another store', async () => {
    findUnique.mockResolvedValueOnce({ id: 'old', storeId: 'store-1', provider: 'TIKTOK', isTestDelivery: false });
    findUnique.mockResolvedValueOnce({ id: 'old', storeId: 'other', provider: 'TIKTOK', isTestDelivery: true });
    expect(await new ConversionDeliveryRepository().enqueue(input())).toEqual({ created: false });
    expect(await new ConversionDeliveryRepository().enqueue(input())).toEqual({ created: false });
    expect(updateMany).not.toHaveBeenCalled();
  });
  it('will not re-arm an in-flight test or a live duplicate', async () => {
    updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await new ConversionDeliveryRepository().enqueue(input())).toEqual({ created: false });
    expect(updateMany.mock.calls[0]![0].where.status.in).not.toContain('PROCESSING');
    expect(updateMany.mock.calls[0]![0].where.status.in).not.toContain('PENDING');
    expect(await new ConversionDeliveryRepository().enqueue({ ...input(), isTestDelivery: false })).toEqual({ created: false });
    expect(updateMany).toHaveBeenCalledTimes(1);
  });
});
