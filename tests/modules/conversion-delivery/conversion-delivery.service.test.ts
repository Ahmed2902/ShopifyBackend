import { describe, expect, it, vi } from 'vitest';
import { ConversionDeliveryService } from '../../../src/modules/conversion-delivery/conversion-delivery.service.js';

const now = new Date('2026-09-28T12:00:00.000Z');

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    orderId: '00000000-0000-0000-0000-000000000010',
    storeId: '00000000-0000-0000-0000-000000000001',
    shopifyOrderId: 'gid://shopify/Order/1001',
    eventAt: new Date('2026-09-28T11:00:00.000Z'),
    value: '129.99',
    currencyCode: 'USD',
    eventSourceUrl: 'https://shop.example/products/hero',
    metaClickId: 'meta-click',
    metaClickEventAt: new Date('2026-09-28T10:00:00.000Z'),
    googleClickId: null,
    googleClickEventAt: null,
    tiktokClickId: null,
    tiktokClickEventAt: null,
    ...overrides,
  };
}

function destination(provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS', id: string) {
  return {
    id,
    storeId: '00000000-0000-0000-0000-000000000001',
    provider,
    externalId: `${provider}-destination`,
    displayName: null,
    accessTokenCiphertext: provider === 'GOOGLE_ADS' ? null : 'encrypted',
    configJson: {},
    status: 'ACTIVE',
    createdAt: now,
    updatedAt: now,
  };
}

function repository(input: {
  destinations?: ReturnType<typeof destination>[];
  candidates?: ReturnType<typeof candidate>[];
  enqueueCreated?: boolean;
} = {}) {
  return {
    activeDestinations: vi.fn().mockResolvedValue(input.destinations ?? []),
    findPurchaseCandidates: vi.fn().mockResolvedValue(input.candidates ?? []),
    enqueue: vi.fn().mockResolvedValue({
      id: 'delivery-1',
      status: 'PENDING',
      created: input.enqueueCreated ?? true,
    }),
    recoverStaleClaims: vi.fn().mockResolvedValue({ count: 0 }),
    claimDue: vi.fn().mockResolvedValue([]),
    upsertDestination: vi.fn().mockResolvedValue({ id: 'destination-1' }),
  };
}

describe('ConversionDeliveryService purchase enqueue', () => {
  it('queues only the provider whose consented click identifier exists', async () => {
    const repo = repository({
      destinations: [
        destination('META', 'meta-destination'),
        destination('TIKTOK', 'tiktok-destination'),
      ],
      candidates: [candidate()],
    });
    const service = new ConversionDeliveryService(repo as never, () => now);

    await expect(service.enqueuePurchases()).resolves.toEqual({
      candidates: 1,
      destinations: 2,
      eligible: 1,
      enqueued: 1,
    });
    expect(repo.enqueue).toHaveBeenCalledTimes(1);
    expect(repo.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'META',
        eventKey: 'stride:purchase:gid://shopify/Order/1001',
        clickId: 'meta-click',
        value: '129.99',
        currencyCode: 'USD',
      }),
    );
  });

  it('does not count an idempotent existing delivery as newly queued', async () => {
    const repo = repository({
      destinations: [destination('META', 'meta-destination')],
      candidates: [candidate()],
      enqueueCreated: false,
    });
    const service = new ConversionDeliveryService(repo as never, () => now);

    const result = await service.enqueuePurchases();
    expect(result.enqueued).toBe(0);
    expect(result.eligible).toBe(1);
  });

  it('does not invent a conversion match when all provider click ids are missing', async () => {
    const repo = repository({
      destinations: [destination('META', 'meta-destination')],
      candidates: [candidate({ metaClickId: null, metaClickEventAt: null })],
    });
    const service = new ConversionDeliveryService(repo as never, () => now);

    const result = await service.enqueuePurchases();
    expect(result).toMatchObject({ eligible: 0, enqueued: 0 });
    expect(repo.enqueue).not.toHaveBeenCalled();
  });
});

describe('ConversionDeliveryService destination configuration', () => {
  it('requires a provider Events API token for Meta and TikTok', async () => {
    const service = new ConversionDeliveryService(repository() as never, () => now);

    await expect(
      service.configureDestination('store-1', {
        provider: 'META',
        externalId: '123',
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'CONVERSION_DESTINATION_TOKEN_REQUIRED' });
  });

  it('requires a Google Ads customer id while keeping its OAuth token in the existing connection', async () => {
    const service = new ConversionDeliveryService(repository() as never, () => now);

    await expect(
      service.configureDestination('store-1', {
        provider: 'GOOGLE_ADS',
        externalId: '987654321',
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_CONVERSION_CUSTOMER_REQUIRED' });
  });
});
