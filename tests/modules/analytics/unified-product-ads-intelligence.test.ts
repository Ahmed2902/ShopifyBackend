import { describe, expect, it, vi } from 'vitest';
import { UnifiedProductAdsIntelligenceService } from '../../../src/modules/analytics/unified-product-ads-intelligence.service.js';

const unknownCurrencyAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'GOOGLE_ADS' as const,
  providerEntityId: '1234567890',
  name: 'Google',
  status: 'ACTIVE',
  currency: null,
  timezone: 'UTC',
  lastSyncedAt: new Date(),
};

function payload() {
  return {
    summary: {
      current: {
        evidenceAvailable: true,
        compatiblePaidSpend: 120,
        exactMappedSpend: 40,
        sharedSpend: 10,
        unmappedSpend: 70,
        mappingCoverage: 1 / 3,
      },
      comparison: {
        evidenceAvailable: true,
        compatiblePaidSpend: 100,
        exactMappedSpend: 30,
        sharedSpend: 10,
        unmappedSpend: 60,
        mappingCoverage: 0.3,
      },
      limitations: ['Shared and ambiguous spend is never allocated to Shopify products.'],
    },
    items: [],
    pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
  };
}

describe('UnifiedProductAdsIntelligenceService', () => {
  it('fails total Product x Ads accounting closed for unknown selected-account currency', async () => {
    const base = { list: vi.fn().mockResolvedValue(payload()) };
    const scope = {
      resolve: vi.fn().mockResolvedValue({
        states: [],
        allSelectedAccounts: [unknownCurrencyAccount],
        accounts: [unknownCurrencyAccount],
      }),
    };
    const service = new UnifiedProductAdsIntelligenceService(base as never, scope as never);
    const result = await service.list('store', {
      provider: 'ALL',
      days: 30,
      page: 1,
      limit: 50,
    });

    expect(result.summary.current).toMatchObject({
      evidenceAvailable: false,
      compatiblePaidSpend: null,
      unmappedSpend: null,
      mappingCoverage: null,
      unknownCurrencyAccountIds: [unknownCurrencyAccount.id],
    });
    expect(result.dataQuality).toEqual({
      unknownCurrencyAccountIds: [unknownCurrencyAccount.id],
      totalAccountingAvailable: false,
    });
  });

  it('preserves exact/shared/unmapped accounting when currency scope is complete', async () => {
    const base = { list: vi.fn().mockResolvedValue(payload()) };
    const scope = {
      resolve: vi.fn().mockResolvedValue({
        states: [],
        allSelectedAccounts: [{ ...unknownCurrencyAccount, currency: 'USD' }],
        accounts: [{ ...unknownCurrencyAccount, currency: 'USD' }],
      }),
    };
    const service = new UnifiedProductAdsIntelligenceService(base as never, scope as never);
    const result = await service.list('store', {
      provider: 'GOOGLE_ADS',
      currency: 'USD',
      days: 30,
      page: 1,
      limit: 50,
    });

    expect(result.summary.current).toMatchObject({
      compatiblePaidSpend: 120,
      exactMappedSpend: 40,
      sharedSpend: 10,
      unmappedSpend: 70,
      mappingCoverage: 1 / 3,
    });
    expect(result.dataQuality.totalAccountingAvailable).toBe(true);
  });
});
