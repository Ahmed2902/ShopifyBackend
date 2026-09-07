import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationRepository } from '../../../src/modules/integrations/integration.repository.js';
import { IntegrationService } from '../../../src/modules/integrations/integration.service.js';

const cacheMocks = vi.hoisted(() => ({
  invalidateStoreDecisionCaches: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../../src/lib/store-decision-cache.js', () => cacheMocks);

function repository(completed: unknown) {
  return {
    completeSyncRun: vi.fn().mockResolvedValue(completed),
  } as unknown as IntegrationRepository;
}

describe('IntegrationService cache freshness', () => {
  beforeEach(() => {
    cacheMocks.invalidateStoreDecisionCaches.mockClear();
  });

  it('invalidates Store decision reads after a successful provider sync commit', async () => {
    const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const repo = repository({
      id: 'sync-1',
      status: 'SUCCEEDED',
      shopifyConnection: { storeId },
      metaConnection: null,
      tiktokConnection: null,
    });
    const service = new IntegrationService(repo);

    await service.completeSyncRun('sync-1', { recordsRead: 10, recordsWritten: 7 });

    expect(repo.completeSyncRun).toHaveBeenCalledWith('sync-1', {
      recordsRead: 10,
      recordsWritten: 7,
      partial: false,
    });
    expect(cacheMocks.invalidateStoreDecisionCaches).toHaveBeenCalledOnce();
    expect(cacheMocks.invalidateStoreDecisionCaches).toHaveBeenCalledWith(storeId);
  });

  it('uses the owning Meta/TikTok relation when Shopify is not the sync provider', async () => {
    const storeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const repo = repository({
      id: 'sync-2',
      status: 'PARTIAL',
      shopifyConnection: null,
      metaConnection: { storeId },
      tiktokConnection: null,
    });

    await new IntegrationService(repo).completeSyncRun('sync-2', { partial: true });

    expect(cacheMocks.invalidateStoreDecisionCaches).toHaveBeenCalledWith(storeId);
  });

  it('does not invent an invalidation scope for an orphaned historical sync run', async () => {
    const repo = repository({
      id: 'sync-orphan',
      status: 'SUCCEEDED',
      shopifyConnection: null,
      metaConnection: null,
      tiktokConnection: null,
    });

    await new IntegrationService(repo).completeSyncRun('sync-orphan');

    expect(cacheMocks.invalidateStoreDecisionCaches).not.toHaveBeenCalled();
  });
});
