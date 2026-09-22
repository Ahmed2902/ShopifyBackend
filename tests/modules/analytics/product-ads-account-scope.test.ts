import { describe, expect, it, vi } from 'vitest';
import type { AdvertisingAnalyticsRepository } from '../../../src/modules/analytics/advertising-analytics.repository.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import type { ProductAdsRepository } from '../../../src/modules/analytics/product-ads.repository.js';
import { ProductAdsWorkspace } from '../../../src/modules/analytics/product-ads.workspace.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-22T08:00:00.000Z');

function buildHarness() {
  const analyticsRepository = {
    getStoreContext: vi.fn().mockResolvedValue({
      id: storeId,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      metaConnection: {
        status: 'ACTIVE',
        selectedAdAccountIds: ['act_101', 'act_202'],
      },
    }),
    getCommerceRows: vi.fn().mockResolvedValue([]),
    getVariantCosts: vi.fn().mockResolvedValue([]),
  } as unknown as AnalyticsRepository;
  const productAdsRepository = {
    getActiveMappings: vi.fn().mockResolvedValue([]),
  } as unknown as ProductAdsRepository;
  const advertisingRepository = {
    getMetaRows: vi.fn().mockResolvedValue([]),
  } as unknown as AdvertisingAnalyticsRepository;
  return {
    analyticsRepository,
    productAdsRepository,
    advertisingRepository,
    workspace: new ProductAdsWorkspace(
      analyticsRepository,
      productAdsRepository,
      advertisingRepository,
    ),
  };
}

describe('Product x Ads selected account scope', () => {
  it('narrows canonical advertising facts and mappings to the requested selected account', async () => {
    const { workspace, advertisingRepository, productAdsRepository } = buildHarness();

    await workspace.list(storeId, { days: 30, page: 1, limit: 50, accountId: 'act_202' }, now);

    expect(advertisingRepository.getMetaRows).toHaveBeenCalledWith(
      storeId,
      ['act_202'],
      expect.any(Date),
      expect.any(Date),
    );
    expect(productAdsRepository.getActiveMappings).toHaveBeenCalledWith(storeId, ['act_202']);
  });

  it('rejects an account that is not selected for the store before reading advertising facts', async () => {
    const { workspace, advertisingRepository, productAdsRepository } = buildHarness();

    await expect(
      workspace.list(
        storeId,
        { days: 30, page: 1, limit: 50, accountId: 'act_not_selected' },
        now,
      ),
    ).rejects.toMatchObject({ code: 'META_AD_ACCOUNT_NOT_SELECTED', statusCode: 400 });
    expect(advertisingRepository.getMetaRows).not.toHaveBeenCalled();
    expect(productAdsRepository.getActiveMappings).not.toHaveBeenCalled();
  });
});
