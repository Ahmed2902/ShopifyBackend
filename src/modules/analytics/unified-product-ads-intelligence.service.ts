import {
  unifiedAdvertisingScopeService,
  type UnifiedAdvertisingScopeService,
} from '../advertising/unified-advertising-scope.service.js';
import type {
  UnifiedAdvertisingListQuery,
  UnifiedAdvertisingRangeQuery,
} from '../advertising/unified-advertising.schema.js';
import {
  unifiedProductAdsService,
  type UnifiedProductAdsService,
} from './unified-product-ads.service.js';

function sanitizeSummaryForUnknownCurrency<T extends {
  current: Record<string, unknown>;
  comparison: Record<string, unknown>;
  limitations: string[];
}>(summary: T, unknownCurrencyAccountIds: string[]) {
  if (unknownCurrencyAccountIds.length === 0) return summary;
  const sanitizePeriod = (period: Record<string, unknown>) => ({
    ...period,
    evidenceAvailable: false,
    compatiblePaidSpend: null,
    unmappedSpend: null,
    mappingCoverage: null,
    unknownCurrencyAccountIds,
  });
  return {
    ...summary,
    current: sanitizePeriod(summary.current),
    comparison: sanitizePeriod(summary.comparison),
    limitations: [
      ...summary.limitations,
      'Total Product × Ads accounting is unavailable because at least one selected advertising account has unknown currency.',
    ],
  };
}

/**
 * Consumer-facing Product × Ads guardrail layer.
 * Direct exact-mapping economics stay in the canonical service. Store-wide accounting fails closed
 * when selected-account currency cannot be established instead of silently excluding that spend.
 */
export class UnifiedProductAdsIntelligenceService {
  constructor(
    private readonly base: UnifiedProductAdsService = unifiedProductAdsService,
    private readonly scope: UnifiedAdvertisingScopeService = unifiedAdvertisingScopeService,
  ) {}

  async list(storeId: string, query: UnifiedAdvertisingListQuery, now = new Date()) {
    const [payload, scoped] = await Promise.all([
      this.base.list(storeId, query, now),
      this.scope.resolve({
        storeId,
        provider: query.provider,
        accountId: query.accountId,
        currency: query.currency,
      }),
    ]);
    const unknownCurrencyAccountIds = scoped.accounts
      .filter((account) => account.currency === null)
      .map((account) => account.id);
    return {
      ...payload,
      summary: sanitizeSummaryForUnknownCurrency(payload.summary, unknownCurrencyAccountIds),
      dataQuality: {
        unknownCurrencyAccountIds,
        totalAccountingAvailable: unknownCurrencyAccountIds.length === 0,
      },
    };
  }

  async detail(
    storeId: string,
    productId: string,
    query: UnifiedAdvertisingRangeQuery,
    now = new Date(),
  ) {
    const [payload, scoped] = await Promise.all([
      this.base.detail(storeId, productId, query, now),
      this.scope.resolve({
        storeId,
        provider: query.provider,
        accountId: query.accountId,
        currency: query.currency,
      }),
    ]);
    const unknownCurrencyAccountIds = scoped.accounts
      .filter((account) => account.currency === null)
      .map((account) => account.id);
    return {
      ...payload,
      summary: sanitizeSummaryForUnknownCurrency(payload.summary, unknownCurrencyAccountIds),
      dataQuality: {
        unknownCurrencyAccountIds,
        totalAccountingAvailable: unknownCurrencyAccountIds.length === 0,
      },
    };
  }
}

export const unifiedProductAdsIntelligenceService =
  new UnifiedProductAdsIntelligenceService();
