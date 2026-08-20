import { describe, expect, it, vi } from 'vitest';
import type { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';
import type { ReconciliationRepository } from '../../../src/modules/reconciliation/reconciliation.repository.js';
import { ReconciliationService } from '../../../src/modules/reconciliation/reconciliation.service.js';

const connectionId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function build(options?: { fail?: boolean; claim?: boolean }) {
  const repository = {
    listDueShopifyConnectionIds: vi.fn().mockResolvedValue([connectionId]),
    tryClaimShopify: vi.fn().mockResolvedValue(
      options?.claim === false ? { claimed: false } : { claimed: true, storeId },
    ),
    markShopifyFailed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReconciliationRepository;
  const reconcileStoreData = options?.fail
    ? vi.fn().mockRejectedValue(new Error('temporary failure'))
    : vi.fn().mockResolvedValue({ status: 'SUCCEEDED' });
  const shopifyService = { reconcileStoreData } as unknown as ShopifyService;
  return {
    repository,
    shopifyService,
    service: new ReconciliationService(repository, shopifyService),
  };
}

describe('ReconciliationService', () => {
  it('claims each due Shopify connection before reconciling it', async () => {
    const { repository, shopifyService, service } = build();

    await expect(service.processDue(5)).resolves.toEqual({
      claimed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(repository.listDueShopifyConnectionIds).toHaveBeenCalledWith(
      5,
      expect.any(Date),
      expect.any(Date),
    );
    expect(shopifyService.reconcileStoreData).toHaveBeenCalledWith(storeId);
    expect(repository.markShopifyFailed).not.toHaveBeenCalled();
  });

  it('does not run provider work when another worker won the claim', async () => {
    const { shopifyService, service } = build({ claim: false });

    await expect(service.processDue()).resolves.toEqual({
      claimed: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(shopifyService.reconcileStoreData).not.toHaveBeenCalled();
  });

  it('releases failed work with a short retry instead of blocking the remaining scheduler', async () => {
    const { repository, service } = build({ fail: true });

    await expect(service.processDue()).resolves.toEqual({
      claimed: 1,
      succeeded: 0,
      failed: 1,
    });
    expect(repository.markShopifyFailed).toHaveBeenCalledWith(
      connectionId,
      expect.any(Date),
    );
  });
});
