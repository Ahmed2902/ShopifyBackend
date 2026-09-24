import { describe, expect, it, vi } from 'vitest';
import { UnifiedDecisionService } from '../../../src/modules/intelligence/unified-decision.service.js';

const window = {
  current: { from: '2026-09-01', to: '2026-09-30' },
  comparison: { from: '2026-08-02', to: '2026-08-31' },
  days: 30,
};

function emptyPage() {
  return { items: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } };
}

describe('UnifiedDecisionService independent provider evidence', () => {
  it('H. keeps provider-only recommendations working while commerce history is incomplete', async () => {
    const campaign = {
      entity: {
        id: 'campaign-1',
        providerEntityId: 'google-campaign-1',
        name: 'Google Search',
        account: { id: 'account-1', provider: 'GOOGLE_ADS' },
      },
      current: { spend: 200, ctr: 0.01 },
      comparison: { spend: 180, ctr: 0.02 },
      intelligence: {
        confidence: 'HIGH' as const,
        signals: [
          {
            code: 'CTR_DECLINED',
            severity: 'WARNING' as const,
            conclusion: 'Provider-reported CTR declined versus the comparison window.',
            evidence: { currentCtr: 0.01, comparisonCtr: 0.02 },
          },
        ],
        limitations: [],
      },
    };
    const advertising = {
      read: vi.fn().mockResolvedValue({
        truthModel: {},
        filters: { provider: 'GOOGLE_ADS', accountId: null, currency: null },
        window,
        dataQuality: { confidence: 'HIGH', items: [] },
      }),
    };
    const entities = {
      list: vi.fn().mockImplementation(async (_storeId: string, kind: string) =>
        kind === 'CAMPAIGN'
          ? {
              items: [campaign],
              pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
            }
          : emptyPage(),
      ),
    };
    const products = { list: vi.fn().mockResolvedValue(emptyPage()) };
    const lifecycle = {
      attach: vi.fn().mockImplementation(async (_storeId: string, drafts: unknown[]) => drafts),
    };
    const context = {
      getContext: vi.fn().mockResolvedValue({
        shopifyConnection: { status: 'ACTIVE' },
        successfulOrderHistorySync: null,
      }),
    };
    const service = new UnifiedDecisionService(
      advertising as never,
      entities as never,
      products as never,
      lifecycle as never,
      context as never,
    );

    const result = await service.read('store-1', { provider: 'GOOGLE_ADS', days: 30 });
    const ids = result.recommendations.map((item) => item.ruleId);

    expect(ids).toContain('unified_campaign_ctr_declined');
    expect(result.dataQuality.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'INCOMPLETE_COMMERCE_HISTORY', status: 'BLOCKED' }),
      ]),
    );
  });
});
