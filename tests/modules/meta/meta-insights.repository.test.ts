import { beforeEach, describe, expect, it, vi } from 'vitest';

const insightUpsert = vi.hoisted(() => vi.fn());
const insightUpdateMany = vi.hoisted(() => vi.fn());
const actionDeleteMany = vi.hoisted(() => vi.fn());
const actionCreateMany = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() =>
  vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      metaInsightDaily: { upsert: insightUpsert, updateMany: insightUpdateMany },
      metaInsightAction: { deleteMany: actionDeleteMany, createMany: actionCreateMany },
    }),
  ),
);

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { $transaction: transaction },
}));

import { MetaInsightsRepository } from '../../../src/modules/meta/insights/meta-insights.repository.js';
import { metaInsightRowSchema } from '../../../src/modules/meta/insights/meta-insights.schema.js';

function row() {
  return metaInsightRowSchema.parse({
    date_start: '2026-09-13',
    date_stop: '2026-09-13',
    account_id: '101',
    account_currency: 'USD',
    campaign_id: 'cmp_1',
    adset_id: 'set_1',
    ad_id: 'ad_1',
    spend: '12.34',
    impressions: '1000',
    clicks: '20',
  });
}

function input(overrides: Partial<Parameters<MetaInsightsRepository['upsertDailyInsight']>[0]> = {}) {
  return {
    adAccountId: 'account-1',
    campaignId: 'campaign-1',
    adSetId: 'adset-1',
    adId: 'ad-1',
    creativeIdSnapshot: null,
    trackCreativeSnapshot: true,
    row: row(),
    actionReportTime: 'impression',
    ...overrides,
  };
}

describe('MetaInsightsRepository creative snapshot provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insightUpsert.mockResolvedValue({ id: 'insight-1' });
    insightUpdateMany.mockResolvedValue({ count: 0 });
    actionDeleteMany.mockResolvedValue({ count: 0 });
    actionCreateMany.mockResolvedValue({ count: 0 });
  });

  it('enrolls a fresh reporting-day row without prematurely assigning a creative', async () => {
    const repository = new MetaInsightsRepository();

    await repository.upsertDailyInsight(input());

    const write = insightUpsert.mock.calls[0]![0];
    expect(write.create.creativeSnapshotTracked).toBe(true);
    expect(write.create.creativeIdSnapshot).toBeNull();
    expect(write.update).not.toHaveProperty('creativeSnapshotTracked');
    expect(write.update).not.toHaveProperty('creativeIdSnapshot');
    expect(insightUpdateMany).not.toHaveBeenCalled();
  });

  it('finalizes only a previously tracked null snapshot after the reporting day completes', async () => {
    const repository = new MetaInsightsRepository();

    await repository.upsertDailyInsight(input({
      creativeIdSnapshot: 'creative-old',
      trackCreativeSnapshot: false,
    }));

    const write = insightUpsert.mock.calls[0]![0];
    expect(write.create.creativeSnapshotTracked).toBe(false);
    expect(write.create.creativeIdSnapshot).toBeNull();
    expect(write.update).not.toHaveProperty('creativeSnapshotTracked');
    expect(write.update).not.toHaveProperty('creativeIdSnapshot');
    expect(insightUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'insight-1',
        creativeSnapshotTracked: true,
        creativeIdSnapshot: null,
      },
      data: { creativeIdSnapshot: 'creative-old' },
    });
  });

  it('cannot overwrite a finalized snapshot because finalization requires the stored snapshot to be null', async () => {
    const repository = new MetaInsightsRepository();

    await repository.upsertDailyInsight(input({
      creativeIdSnapshot: 'creative-new',
      trackCreativeSnapshot: false,
    }));

    expect(insightUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        creativeSnapshotTracked: true,
        creativeIdSnapshot: null,
      }),
      data: { creativeIdSnapshot: 'creative-new' },
    }));
  });

  it('keeps untracked historical/backfill rows unassigned even when a current creative candidate exists', async () => {
    const repository = new MetaInsightsRepository();

    await repository.upsertDailyInsight(input({
      creativeIdSnapshot: 'creative-current',
      trackCreativeSnapshot: false,
    }));

    const write = insightUpsert.mock.calls[0]![0];
    expect(write.create.creativeSnapshotTracked).toBe(false);
    expect(write.create.creativeIdSnapshot).toBeNull();
    expect(insightUpdateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ creativeSnapshotTracked: true }),
    }));
  });
});
