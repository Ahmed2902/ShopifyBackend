import { describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../../src/errors/app-error.js';
import {
  aggregateUnifiedAdvertisingMetrics,
} from '../../../src/modules/advertising/unified-advertising.service.js';
import {
  UnifiedAdvertisingIntelligenceService,
  unifiedEvidenceConfidence,
} from '../../../src/modules/advertising/unified-advertising-intelligence.service.js';
import { UnifiedAdvertisingScopeService } from '../../../src/modules/advertising/unified-advertising-scope.service.js';
import { unifiedAdvertisingRangeQuerySchema } from '../../../src/modules/advertising/unified-advertising.schema.js';

const metaAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'META' as const,
  providerEntityId: 'act_1',
  name: 'Meta',
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  lastSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
};
const googleAccount = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'GOOGLE_ADS' as const,
  providerEntityId: '1234567890',
  name: 'Google',
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  lastSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
};
const tiktokAccount = {
  id: '33333333-3333-4333-8333-333333333333',
  provider: 'TIKTOK' as const,
  providerEntityId: 'tt_1',
  name: 'TikTok',
  status: 'ACTIVE',
  currency: 'EUR',
  timezone: 'UTC',
  lastSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
};

function state(provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS', selectedExternalIds: string[]) {
  return { provider, status: 'ACTIVE', selectedExternalIds, lastSyncedAt: new Date(), lastSyncStatus: null };
}

function scopedService() {
  const repository = {
    connectionStates: vi.fn().mockResolvedValue([
      state('META', ['act_1']),
      state('TIKTOK', ['tt_1']),
      state('GOOGLE_ADS', ['1234567890']),
    ]),
    selectedAccounts: vi.fn().mockResolvedValue([metaAccount, tiktokAccount, googleAccount]),
  };
  const billing = {
    requireActive: vi.fn().mockResolvedValue({
      entitlements: { maxAdChannels: null },
      essentialsAdProvider: null,
    }),
    requireAdProviderReadOnly: vi.fn().mockResolvedValue({
      entitlements: { maxAdChannels: null },
      essentialsAdProvider: null,
    }),
  };
  return new UnifiedAdvertisingScopeService(repository as never, billing as never);
}

function metrics(available = true) {
  return {
    evidenceAvailable: available,
    sourceRows: available ? 1 : 0,
    spend: available ? 10 : null,
    impressions: available ? 1000 : null,
    clicks: available ? 20 : null,
    ctr: available ? 0.02 : null,
    cpc: available ? 0.5 : null,
    cpm: available ? 10 : null,
    providerConversions: available ? 1 : null,
    providerConversionValue: available ? 20 : null,
    providerRoas: available ? 2 : null,
    reach: null,
    latestSyncedAt: available ? new Date('2026-09-23T00:00:00.000Z') : null,
  };
}

function economics() {
  return {
    currency: 'USD',
    current: { compatiblePaidSpend: 100, mer: 5, adSpendRatio: 0.2, contributionAfterAdvertising: 300, evidenceAvailable: true, missingAccountIds: [] },
    comparison: { compatiblePaidSpend: 80, mer: 5, adSpendRatio: 0.2, contributionAfterAdvertising: 250, evidenceAvailable: true, missingAccountIds: [] },
    change: {},
  };
}

describe('unified advertising contracts', () => {
  it('parses provider/account/currency/date filters without provider-specific vocabulary', () => {
    expect(
      unifiedAdvertisingRangeQuerySchema.parse({
        provider: 'GOOGLE_ADS',
        accountId: googleAccount.id,
        currency: 'usd',
        days: '14',
      }),
    ).toMatchObject({ provider: 'GOOGLE_ADS', accountId: googleAccount.id, currency: 'USD', days: 14 });
    expect(() => unifiedAdvertisingRangeQuerySchema.parse({ from: '2026-09-01' })).toThrow();
  });

  it('keeps missing provider metrics unavailable instead of manufacturing zeros', () => {
    expect(aggregateUnifiedAdvertisingMetrics([])).toMatchObject({
      evidenceAvailable: false,
      spend: null,
      impressions: null,
      clicks: null,
      providerConversions: null,
      providerConversionValue: null,
      providerRoas: null,
      reach: null,
    });
  });

  it('computes common counters and provider ROAS only from provider evidence', () => {
    const value = aggregateUnifiedAdvertisingMetrics([
      {
        period: 'CURRENT', accountId: metaAccount.id, currency: 'USD', sourceRows: 2,
        conversionRows: 2, conversionValueRows: 2,
        spend: 100, impressions: 10000, clicks: 200, conversions: 10,
        conversionValue: 400, latestSyncedAt: new Date('2026-09-23T00:00:00.000Z'),
      },
    ]);
    expect(value).toMatchObject({
      evidenceAvailable: true,
      spend: 100,
      impressions: 10000,
      clicks: 200,
      ctr: 0.02,
      cpc: 0.5,
      cpm: 10,
      providerConversions: 10,
      providerConversionValue: 400,
      providerRoas: 4,
      reach: null,
    });
  });

  it('supports ALL and each provider independently without cross-provider leakage', async () => {
    const service = scopedService();
    const all = await service.resolve({ storeId: 'store', provider: 'ALL' });
    const meta = await service.resolve({ storeId: 'store', provider: 'META' });
    const tiktok = await service.resolve({ storeId: 'store', provider: 'TIKTOK' });
    const google = await service.resolve({ storeId: 'store', provider: 'GOOGLE_ADS' });
    expect(all.accounts.map((account) => account.provider).sort()).toEqual([
      'GOOGLE_ADS', 'META', 'TIKTOK',
    ]);
    expect(meta.accounts).toEqual([metaAccount]);
    expect(tiktok.accounts).toEqual([tiktokAccount]);
    expect(google.accounts).toEqual([googleAccount]);
  });

  it('supports provider combinations through ALL plus currency narrowing without mixing currencies', async () => {
    const service = scopedService();
    const usd = await service.resolve({ storeId: 'store', provider: 'ALL', currency: 'USD' });
    const eur = await service.resolve({ storeId: 'store', provider: 'ALL', currency: 'EUR' });
    expect(usd.accounts.map((account) => account.provider).sort()).toEqual(['GOOGLE_ADS', 'META']);
    expect(eur.accounts).toEqual([tiktokAccount]);
  });

  it('rejects cross-store/unselected accounts and provider mismatches before reads', async () => {
    const service = scopedService();

    await expect(
      service.resolve({ storeId: 'store', accountId: '44444444-4444-4444-8444-444444444444' }),
    ).rejects.toMatchObject({ code: 'ADVERTISING_ACCOUNT_NOT_SELECTED', statusCode: 400 } satisfies Partial<AppError>);
    await expect(
      service.resolve({ storeId: 'store', provider: 'META', accountId: googleAccount.id }),
    ).rejects.toMatchObject({ code: 'ADVERTISING_ACCOUNT_PROVIDER_MISMATCH', statusCode: 400 } satisfies Partial<AppError>);
    const scoped = await service.resolve({ storeId: 'store', provider: 'GOOGLE_ADS', accountId: googleAccount.id });
    expect(scoped.accounts).toEqual([googleAccount]);
  });

  it('does not let permanently unavailable deduplicated reach cap otherwise complete evidence', () => {
    expect(
      unifiedEvidenceConfidence(
        [{ code: 'UNAVAILABLE_REACH', status: 'WARNING', surface: 'PAID_MEDIA', message: 'Unsupported.' }],
        true,
      ),
    ).toBe('HIGH');
    expect(
      unifiedEvidenceConfidence(
        [{ code: 'STALE_SYNC', status: 'WARNING', surface: 'PAID_MEDIA', message: 'Stale.' }],
        true,
      ),
    ).toBe('MEDIUM');
    expect(
      unifiedEvidenceConfidence(
        [{ code: 'MISSING_PAID_MEDIA_EVIDENCE', status: 'BLOCKED', surface: 'PAID_MEDIA', message: 'Missing.' }],
        true,
      ),
    ).toBe('LOW');
  });

  it('fails blended economics closed when any selected account has unknown currency', async () => {
    const unknown = { ...googleAccount, currency: null };
    const basePayload = {
      accounts: [metaAccount, unknown],
      providerEvidence: [],
      accountEvidence: [],
      dataQuality: { confidence: 'LOW', items: [] },
      blendedEconomics: economics(),
    };
    const base = { read: vi.fn().mockResolvedValue(basePayload) };
    const service = new UnifiedAdvertisingIntelligenceService(base as never);
    const result = await service.read('store', { provider: 'ALL', days: 30 });
    expect(result.blendedEconomics.current).toMatchObject({
      compatiblePaidSpend: null,
      mer: null,
      adSpendRatio: null,
      contributionAfterAdvertising: null,
      evidenceAvailable: false,
      unknownCurrencyAccountIds: [unknown.id],
    });
  });

  it('labels mixed known currencies instead of silently implying every provider entered blended economics', async () => {
    const base = {
      read: vi.fn().mockResolvedValue({
        accounts: [metaAccount, tiktokAccount],
        providerEvidence: [],
        accountEvidence: [
          { account: metaAccount, current: metrics(), comparison: metrics(), change: {} },
          { account: tiktokAccount, current: metrics(), comparison: metrics(), change: {} },
        ],
        dataQuality: { confidence: 'HIGH', items: [] },
        blendedEconomics: economics(),
      }),
    };
    const result = await new UnifiedAdvertisingIntelligenceService(base as never).read(
      'store',
      { provider: 'ALL', days: 30 },
    );
    expect(result.dataQuality.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CURRENCY_MISMATCH', status: 'WARNING' }),
      ]),
    );
    expect(result.blendedEconomics.current.excludedCurrencyAccountIds).toEqual([tiktokAccount.id]);
    expect(result.dataQuality.confidence).toBe('MEDIUM');
  });

  it('removes unrelated provider warnings from an explicit account-scoped read', async () => {
    const base = {
      read: vi.fn().mockResolvedValue({
        accounts: [metaAccount],
        providerEvidence: [],
        accountEvidence: [
          { account: metaAccount, current: metrics(), comparison: metrics(), change: {} },
        ],
        dataQuality: {
          confidence: 'MEDIUM',
          items: [
            { code: 'PROVIDER_DISCONNECTED', status: 'WARNING', surface: 'PAID_MEDIA', provider: 'TIKTOK', message: 'TikTok disconnected.' },
            { code: 'UNAVAILABLE_REACH', status: 'WARNING', surface: 'PAID_MEDIA', message: 'Unsupported.' },
          ],
        },
        blendedEconomics: economics(),
      }),
    };
    const result = await new UnifiedAdvertisingIntelligenceService(base as never).read(
      'store',
      { provider: 'ALL', accountId: metaAccount.id, days: 30 },
    );
    expect(result.dataQuality.items.map((item) => item.code)).toEqual(['UNAVAILABLE_REACH']);
    expect(result.dataQuality.confidence).toBe('HIGH');
  });
});
