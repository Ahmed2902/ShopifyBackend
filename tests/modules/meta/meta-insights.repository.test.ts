import { beforeEach, describe, expect, it, vi } from 'vitest';

const insightUpsert = vi.hoisted(() => vi.fn());
const actionDeleteMany = vi.hoisted(() => vi.fn());
const actionCreateMany = vi.hoisted(() => vi.fn());
const transaction = vi.hoisted(() =>
  vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      metaInsightDaily: { upsert: insightUpsert },
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

describe('MetaInsightsRepository creative snapshot immutability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insightUpsert.mockResolvedValue({ id: 'insight-1' });
    actionDeleteMany.mockResolvedValue({ count: 0 });
    actionCreateMany.mockResolvedValue({ count: 0 });
  });

  it('writes the creative snapshot only on create and never overwrites it on refresh', async () => {
    const repository = new MetaInsightsRepository();

    await repository.upsertDailyInsight({
      adAccountId: 'account-1',
      campaignId: 'campaign-1',
      adSetId: 'adset-1',
      adId: 'ad-1',
      creativeIdSnapshot: 'creative-old',
      row: row(),
      actionReportTime: 'impression',
    });

    await repository.upsertDailyInsight({
      adAccountId: 'account-1',
      campaignId: 'campaign-1',
      adSetId: 'adset-1',
      adId: 'ad-1',
      creativeIdSnapshot: 'creative-new',
      row: row(),
      actionReportTime: 'impression',
    });

    const firstWrite = insightUpsert.mock.calls[0]![0];
    const refreshWrite = insightUpsert.mock.calls[1]![0];

    expect(firstWrite.create.creativeIdSnapshot).toBe('creative-old');
    expect(firstWrite.update).not.toHaveProperty('creativeIdSnapshot');
    expect(refreshWrite.create.creativeIdSnapshot).toBe('creative-new');
    expect(refreshWrite.update).not.toHaveProperty('creativeIdSnapshot');
  });
});
