import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
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

function claim(provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS' = 'META') {
  return {
    id: 'delivery-1',
    storeId: '00000000-0000-0000-0000-000000000001',
    destinationId: 'destination-1',
    provider,
    eventKey: 'stride:purchase:gid://shopify/Order/1001',
    sourceOrderId: '00000000-0000-0000-0000-000000000010',
    shopifyOrderId: 'gid://shopify/Order/1001',
    eventAt: now,
    value: '129.99',
    currencyCode: 'USD',
    clickId: 'click-id',
    attributionEventAt: now,
    eventSourceUrl: 'https://shop.example/products/hero',
    attempts: 0,
    externalId: 'provider-destination',
    accessTokenCiphertext: 'encrypted',
    configJson: {},
  };
}

function repository(input: {
  destinations?: ReturnType<typeof destination>[];
  candidates?: ReturnType<typeof candidate>[];
  claims?: ReturnType<typeof claim>[];
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
    claimDue: vi.fn().mockResolvedValue(input.claims ?? []),
    markFailed: vi.fn().mockResolvedValue(undefined),
    pauseForBilling: vi.fn().mockResolvedValue(undefined),
    markDelivered: vi.fn().mockResolvedValue(undefined),
    upsertDestination: vi.fn().mockResolvedValue({ id: 'destination-1' }),
  };
}

function billing(overrides: Record<string, unknown> = {}) {
  return {
    requireAdProvider: vi.fn().mockResolvedValue({ effectivePlan: 'PRO' }),
    requireAdProviderReadOnly: vi.fn().mockResolvedValue({ effectivePlan: 'PRO' }),
    ...overrides,
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
    const plan = billing();
    const service = new ConversionDeliveryService(repo as never, () => now, plan as never);

    await expect(service.enqueuePurchases()).resolves.toEqual({
      candidates: 1,
      destinations: 2,
      eligible: 1,
      enqueued: 1,
    });
    expect(plan.requireAdProviderReadOnly).toHaveBeenCalledWith(
      '00000000-0000-0000-0000-000000000001',
      'META',
    );
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
    const service = new ConversionDeliveryService(repo as never, () => now, billing() as never);

    const result = await service.enqueuePurchases();
    expect(result.enqueued).toBe(0);
    expect(result.eligible).toBe(1);
  });

  it('does not invent a conversion match when all provider click ids are missing', async () => {
    const repo = repository({
      destinations: [destination('META', 'meta-destination')],
      candidates: [candidate({ metaClickId: null, metaClickEventAt: null })],
    });
    const service = new ConversionDeliveryService(repo as never, () => now, billing() as never);

    const result = await service.enqueuePurchases();
    expect(result).toMatchObject({ eligible: 0, enqueued: 0 });
    expect(repo.enqueue).not.toHaveBeenCalled();
  });

  it('does not enqueue a destination that the current plan does not authorize', async () => {
    const repo = repository({
      destinations: [destination('META', 'meta-destination')],
      candidates: [candidate()],
    });
    const plan = billing({
      requireAdProviderReadOnly: vi
        .fn()
        .mockRejectedValue(new AppError('Choose another channel', 403, 'PLAN_AD_CHANNEL_LIMIT')),
    });
    const service = new ConversionDeliveryService(repo as never, () => now, plan as never);

    await expect(service.enqueuePurchases()).resolves.toMatchObject({ eligible: 0, enqueued: 0 });
    expect(repo.enqueue).not.toHaveBeenCalled();
  });
});

describe('ConversionDeliveryService destination configuration', () => {
  it('checks the selected provider entitlement before storing a destination', async () => {
    const plan = billing();
    const service = new ConversionDeliveryService(repository() as never, () => now, plan as never);

    await service.configureDestination('store-1', {
      provider: 'META',
      externalId: '123',
      accessToken: 'events-token',
      config: {},
    });

    expect(plan.requireAdProvider).toHaveBeenCalledWith('store-1', 'META');
  });

  it('requires a provider Events API token for Meta and TikTok', async () => {
    const service = new ConversionDeliveryService(repository() as never, () => now, billing() as never);

    await expect(
      service.configureDestination('store-1', {
        provider: 'META',
        externalId: '123',
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'CONVERSION_DESTINATION_TOKEN_REQUIRED' });
  });

  it('requires a Google Ads customer id while keeping its OAuth token in the existing connection', async () => {
    const service = new ConversionDeliveryService(repository() as never, () => now, billing() as never);

    await expect(
      service.configureDestination('store-1', {
        provider: 'GOOGLE_ADS',
        externalId: '987654321',
        config: {},
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_CONVERSION_CUSTOMER_REQUIRED' });
  });
});

describe('ConversionDeliveryService worker billing enforcement', () => {
  it('pauses a claimed delivery if a downgrade/channel change no longer authorizes its provider', async () => {
    const repo = repository({ claims: [claim('META')] });
    const plan = billing({
      requireAdProviderReadOnly: vi
        .fn()
        .mockRejectedValue(new AppError('Choose another channel', 403, 'PLAN_AD_CHANNEL_LIMIT')),
    });
    const service = new ConversionDeliveryService(repo as never, () => now, plan as never);

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      retrying: 1,
      dead: 0,
    });

    expect(repo.pauseForBilling).toHaveBeenCalledWith(
      'delivery-1',
      new Date('2026-09-28T18:00:00.000Z'),
    );
    expect(repo.markFailed).not.toHaveBeenCalled();
    expect(repo.markDelivered).not.toHaveBeenCalled();
  });
});
