import { describe, expect, it, vi } from 'vitest';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import type { AdExposureRepository } from '../../../src/modules/analytics/ad-exposure.repository.js';
import { AdExposureWorkspace } from '../../../src/modules/analytics/ad-exposure.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-22T08:00:00.000Z');

function build() {
  const analyticsRepository = {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      inventoryIntelligenceMode: 'DISABLED',
      shopifyConnection: null,
      metaConnection: {
        status: 'ACTIVE',
        selectedAdAccountIds: ['act_1', 'act_2'],
      },
    }),
  } as unknown as AnalyticsRepository;
  const repository = {
    getAdsPage: vi.fn().mockResolvedValue({ total: 0, items: [] }),
  } as unknown as AdExposureRepository;
  return {
    analyticsRepository,
    repository,
    workspace: new AdExposureWorkspace(analyticsRepository, repository),
  };
}

describe('AdExposureWorkspace Meta account scope', () => {
  it('narrows ad exposure reads to the requested selected account', async () => {
    const { workspace, repository } = build();

    await workspace.list(
      storeId,
      { days: 30, page: 1, limit: 50, accountId: 'act_2' },
      now,
    );

    expect(repository.getAdsPage).toHaveBeenCalledWith(storeId, ['act_2'], 1, 50);
  });

  it('rejects an ad exposure account scope that is not selected for the store', async () => {
    const { workspace, repository } = build();

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
