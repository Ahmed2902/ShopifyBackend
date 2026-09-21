import { beforeEach, describe, expect, it, vi } from 'vitest';

const subscriptionRepository = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('../../../src/config/env.js', () => ({
  env: {
    SHOPIFY_APP_PRICING_ENABLED: true,
    SHOPIFY_BILLING_VERIFY_TTL_SECONDS: 300,
    LOG_LEVEL: 'silent',
  },
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    storeSubscription: subscriptionRepository,
  },
}));

vi.mock('../../../src/modules/billing/billing.service.js', () => ({
  billingService: { refreshFromShopify: vi.fn() },
}));

import { BillingReconciliationService } from '../../../src/modules/billing/billing-reconciliation.service.js';

const firstStoreId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const secondStoreId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('BillingReconciliationService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('selects stale active Shopify subscriptions and refreshes them from the persistent worker', async () => {
    subscriptionRepository.findMany.mockResolvedValue([
      { storeId: firstStoreId },
      { storeId: secondStoreId },
    ]);
    const billing = {
      refreshFromShopify: vi.fn().mockResolvedValue({ accessActive: true }),
    };
    const service = new BillingReconciliationService(billing as never);
    const now = new Date('2026-09-20T12:00:00.000Z');

    await expect(service.processDue(5, now)).resolves.toEqual({
      selected: 2,
      succeeded: 2,
      failed: 0,
    });

    expect(subscriptionRepository.findMany).toHaveBeenCalledWith({
      where: {
        provider: 'SHOPIFY',
        status: 'ACTIVE',
        OR: [
          { lastVerifiedAt: null },
          { lastVerifiedAt: { lte: new Date('2026-09-20T11:55:00.000Z') } },
        ],
      },
      orderBy: [{ lastVerifiedAt: 'asc' }, { updatedAt: 'asc' }],
      take: 5,
      select: { storeId: true },
    });
    expect(billing.refreshFromShopify).toHaveBeenNthCalledWith(1, firstStoreId);
    expect(billing.refreshFromShopify).toHaveBeenNthCalledWith(2, secondStoreId);
  });

  it('continues the reconciliation batch when one merchant refresh fails', async () => {
    subscriptionRepository.findMany.mockResolvedValue([
      { storeId: firstStoreId },
      { storeId: secondStoreId },
    ]);
    const billing = {
      refreshFromShopify: vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary Shopify failure'))
        .mockResolvedValueOnce({ accessActive: true }),
    };
    const service = new BillingReconciliationService(billing as never);

    await expect(service.processDue(5)).resolves.toEqual({
      selected: 2,
      succeeded: 1,
      failed: 1,
    });
    expect(billing.refreshFromShopify).toHaveBeenCalledTimes(2);
  });
});
