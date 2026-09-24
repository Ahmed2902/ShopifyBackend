import { describe, expect, it, vi } from 'vitest';
import { UnifiedAdvertisingIntelligenceService } from '../../../src/modules/advertising/unified-advertising-intelligence.service.js';

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'META' as const,
  providerEntityId: 'act_selected',
  name: 'Selected Meta',
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  lastSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
};

function metrics() {
  return {
    evidenceAvailable: true,
    sourceRows: 1,
    spend: 10,
    impressions: 1000,
    clicks: 20,
    ctr: 0.02,
    cpc: 0.5,
    cpm: 10,
    providerConversions: 1,
    providerConversionValue: 20,
    providerRoas: 2,
    reach: null,
    latestSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
  };
}

describe('unified advertising account quality scope', () => {
  it('does not inherit another selected account missing-canonical blocker from the same provider', async () => {
    const base = {
      read: vi.fn().mockResolvedValue({
        accounts: [account],
        providerEvidence: [],
        accountEvidence: [{ account, current: metrics(), comparison: metrics(), change: {} }],
        dataQuality: {
          confidence: 'LOW',
          items: [
            {
              code: 'SELECTED_ACCOUNT_EVIDENCE_MISSING',
              status: 'BLOCKED',
              surface: 'PAID_MEDIA',
              provider: 'META',
              message: 'A different selected Meta account is not canonical yet.',
            },
            {
              code: 'UNAVAILABLE_REACH',
              status: 'WARNING',
              surface: 'PAID_MEDIA',
              message: 'Unsupported.',
            },
          ],
        },
        blendedEconomics: {
          currency: 'USD',
          current: {
            compatiblePaidSpend: 10,
            mer: 5,
            adSpendRatio: 0.2,
            contributionAfterAdvertising: 30,
            evidenceAvailable: true,
            missingAccountIds: [],
          },
          comparison: {
            compatiblePaidSpend: 10,
            mer: 5,
            adSpendRatio: 0.2,
            contributionAfterAdvertising: 30,
            evidenceAvailable: true,
            missingAccountIds: [],
          },
          change: {},
        },
      }),
    };

    const result = await new UnifiedAdvertisingIntelligenceService(base as never).read(
      'store-1',
      { provider: 'ALL', accountId: account.id, days: 30 },
    );

    expect(result.dataQuality.items.map((item) => item.code)).toEqual(['UNAVAILABLE_REACH']);
    expect(result.dataQuality.confidence).toBe('HIGH');
  });
});
