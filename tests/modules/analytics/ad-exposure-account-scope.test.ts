import { describe, expect, it, vi } from 'vitest';
import type { AdvertisingAnalyticsRepository } from '../../../src/modules/analytics/advertising-analytics.repository.js';
import type { AdExposureRepository } from '../../../src/modules/analytics/ad-exposure.repository.js';
import { AdExposureWorkspace } from '../../../src/modules/analytics/ad-exposure.workspace.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-22T08:00:00.000Z');

function buildHarness() {
  const analyticsRepository = {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'DISABLED',
      shopifyConnection: null,
      metaConnection: {
        status: 'ACTIVE',
        selectedAdAccountIds: ['act_101', 'act_202'],
      },
    }),
  } as unknown as AnalyticsRepository;
  const repository = {
    getAdsPage: vi.fn().mockResolvedValue({ items: [], total: 0 }),
  } as unknown as AdExposureRepository;
  const advertisingRepository = {} as AdvertisingAnalyticsRepository;

  return {
    analyticsRepository,
    repository,
    workspace: new AdExposureWorkspace(
      analyticsRepository,
      repository,
      advertisingRepository,
    ),
  };
}

describe('Ad Exposure selected account scope', () => {
  it('narrows canonical exposure reads to exactly one selected account', async () => {
    const { workspace, repository } = buildHarness();

    await workspace.list(
      storeId,
      { days: 30, page: 1, limit: 50, accountId: 'act_202' },
      now,
    );

    expect(repository.getAdsPage).toHaveBeenCalledWith(storeId, ['act_202'], 1, 50);
  });

  it('rejects an account that is not selected before canonical exposure reads', async () => {
    const { workspace, repository } = buildHarness();

    await expect(
      workspace.list(
        storeId,
        { days: 30, page: 1, limit: 50, accountId: 'act_not_selected' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'META_AD_ACCOUNT_NOT_SELECTED', statusCode: 400 });
    expect(repository.getAdsPage).not.toHaveBeenCalled();
  });
});
