import { describe, expect, it, vi } from 'vitest';
import type { AdvertisingAnalyticsReadRepository } from '../../../src/modules/analytics/advertising-analytics.read.repository.js';
import type { AdvertisingEntityAnalyticsReadRepository } from '../../../src/modules/analytics/advertising-entity-analytics.read.repository.js';
import { AdvertisingAnalyticsService } from '../../../src/modules/analytics/advertising-analytics.service.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import type { CreativeAdvertisingReadRepository } from '../../../src/modules/analytics/creative-advertising.read.repository.js';
import type { CreativeVideoRetentionService } from '../../../src/modules/analytics/creative-video-retention.service.js';

const windows = {
  current: {
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    metaFrom: new Date('2026-09-01T00:00:00.000Z'),
    metaTo: new Date('2026-09-07T00:00:00.000Z'),
    instantFrom: new Date('2026-09-01T00:00:00.000Z'),
    instantTo: new Date('2026-09-07T23:59:59.999Z'),
  },
  comparison: {
    fromDate: '2026-08-25',
    toDate: '2026-08-31',
    metaFrom: new Date('2026-08-25T00:00:00.000Z'),
    metaTo: new Date('2026-08-31T00:00:00.000Z'),
    instantFrom: new Date('2026-08-25T00:00:00.000Z'),
    instantTo: new Date('2026-08-31T23:59:59.999Z'),
  },
  days: 7,
};

const store = {
  id: 'store-1',
  currencyCode: 'USD',
  ianaTimezone: 'UTC',
  inventoryIntelligenceMode: 'DISABLED',
  shopifyConnection: null,
  metaConnection: { status: 'ACTIVE', selectedAdAccountIds: ['act-1'] },
};

function creative(id: string) {
  return {
    id,
    metaCreativeId: `meta-${id}`,
    name: id,
    title: id,
    body: null,
    callToActionType: null,
    imageUrl: null,
    thumbnailUrl: null,
    videoId: 'video-1',
    linkUrl: null,
  };
}

function metricRow(creativeIdSnapshot: string, date = '2026-09-02') {
  return {
    date: new Date(`${date}T00:00:00.000Z`),
    creativeIdSnapshot,
    accountCurrency: 'USD',
    spend: 50,
    impressions: 1_000n,
    clicks: 100n,
    frequency: 1.2,
    attributionSetting: '7d_click_1d_view',
    actions: [
      { kind: 'ACTION', actionType: 'purchase', actionDestination: null, value: 2 },
      { kind: 'ACTION_VALUE', actionType: 'purchase', actionDestination: null, value: 150 },
    ],
  };
}

function build() {
  const repository = {
    getCreativesPage: vi.fn().mockResolvedValue({
      total: 2,
      items: [creative('creative-old'), creative('creative-new')],
    }),
    getCreative: vi.fn().mockImplementation(async (_storeId, _accounts, id) => creative(id)),
    getMetaRows: vi.fn().mockResolvedValue([]),
  } as unknown as AnalyticsRepository;
  const readRepository = {} as AdvertisingAnalyticsReadRepository;
  const videoRetentionService = {
    forCreatives: vi.fn().mockResolvedValue(new Map()),
  } as unknown as CreativeVideoRetentionService;
  const creativeReadRepository = {
    getRows: vi.fn().mockResolvedValue([metricRow('creative-old')]),
  } as unknown as CreativeAdvertisingReadRepository;
  const entityReadRepository = {
    getAggregateRows: vi.fn().mockResolvedValue([
      {
        period: 'CURRENT',
        entityId: 'creative-old',
        accountCurrency: 'USD',
        spend: 50,
        impressions: 1_000,
        clicks: 100,
        purchases: 2,
        purchaseValue: 150,
        weightedFrequency: 1_200,
      },
    ]),
  } as unknown as AdvertisingEntityAnalyticsReadRepository;

  return {
    repository,
    creativeReadRepository,
    entityReadRepository,
    service: new AdvertisingAnalyticsService(
      repository,
      readRepository,
      videoRetentionService,
      creativeReadRepository,
      entityReadRepository,
    ),
  };
}

describe('AdvertisingAnalyticsService creative snapshot metrics', () => {
  it('keeps creative list spend and outcomes bound to the immutable insight snapshot aggregate', async () => {
    const { repository, creativeReadRepository, entityReadRepository, service } = build();

    const result = await service.creatives(store as never, windows, 1, 50);

    expect(result.items[0]?.entity.id).toBe('creative-old');
    expect(result.items[0]?.current).toMatchObject({ spend: 50, purchases: 2, purchaseValue: 150 });
    expect(result.items[1]?.entity.id).toBe('creative-new');
    expect(result.items[1]?.current.spend).toBe(0);
    expect(repository.getMetaRows).not.toHaveBeenCalled();
    expect(creativeReadRepository.getRows).not.toHaveBeenCalled();
    expect(entityReadRepository.getAggregateRows).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'CREATIVE',
      entityIds: ['creative-old', 'creative-new'],
    }));
  });

  it('uses snapshot-bound rows for creative detail and daily metrics', async () => {
    const { repository, creativeReadRepository, entityReadRepository, service } = build();

    const result = await service.creative(store as never, windows, 'creative-old');

    expect(result.current).toMatchObject({ spend: 50, purchases: 2, providerRoas: 3 });
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject({ date: '2026-09-02', spend: 50 });
    expect(result.attributionSettings).toEqual(['7d_click_1d_view']);
    expect(repository.getMetaRows).not.toHaveBeenCalled();
    expect(entityReadRepository.getAggregateRows).not.toHaveBeenCalled();
    expect(creativeReadRepository.getRows).toHaveBeenCalledWith(expect.objectContaining({
      creativeIds: ['creative-old'],
    }));
  });
});
