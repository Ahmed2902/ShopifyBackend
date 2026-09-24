import type { UnifiedAdvertisingRangeQuery } from './unified-advertising.schema.js';
import {
  unifiedAdvertisingService,
  type UnifiedAdvertisingMetrics,
  type UnifiedAdvertisingService,
  type UnifiedDataQualityItem,
  type UnifiedEvidenceConfidence,
} from './unified-advertising.service.js';

function delta(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  return current - comparison;
}

function metricAbsoluteChange(
  current: UnifiedAdvertisingMetrics,
  comparison: UnifiedAdvertisingMetrics,
) {
  return {
    spend: delta(current.spend, comparison.spend),
    impressions: delta(current.impressions, comparison.impressions),
    clicks: delta(current.clicks, comparison.clicks),
    ctr: delta(current.ctr, comparison.ctr),
    cpc: delta(current.cpc, comparison.cpc),
    cpm: delta(current.cpm, comparison.cpm),
    providerConversions: delta(current.providerConversions, comparison.providerConversions),
    providerConversionValue: delta(
      current.providerConversionValue,
      comparison.providerConversionValue,
    ),
    providerRoas: delta(current.providerRoas, comparison.providerRoas),
    reach: null,
  };
}

/**
 * Confidence is evidence quality, not a probability. Unsupported non-required capabilities such as
 * deduplicated reach stay visible as limitations but do not permanently cap otherwise complete
 * evidence at MEDIUM.
 */
export function unifiedEvidenceConfidence(
  items: UnifiedDataQualityItem[],
  comparisonComplete: boolean,
): UnifiedEvidenceConfidence {
  const relevant = items.filter((item) => item.code !== 'UNAVAILABLE_REACH');
  if (relevant.some((item) => item.status === 'BLOCKED')) return 'LOW';
  if (relevant.some((item) => item.status === 'WARNING') || !comparisonComplete) return 'MEDIUM';
  return 'HIGH';
}

/**
 * Final public composition boundary for unified paid-media reads.
 *
 * The lower-level service intentionally owns provider aggregation. This layer owns the business
 * truth guardrails that consumers must never have to infer: unknown account currency makes blended
 * economics unavailable, provider attribution never becomes Shopify revenue, and absolute deltas
 * travel beside percentage changes.
 */
export class UnifiedAdvertisingIntelligenceService {
  constructor(
    private readonly base: UnifiedAdvertisingService = unifiedAdvertisingService,
  ) {}

  async read(storeId: string, query: UnifiedAdvertisingRangeQuery, now = new Date()) {
    const payload = await this.base.read(storeId, query, now);
    const unknownCurrencyAccountIds = payload.accounts
      .filter((account) => account.currency === null)
      .map((account) => account.id);
    const foreignCurrencyAccountIds = payload.accounts
      .filter(
        (account) =>
          account.currency !== null && account.currency !== payload.blendedEconomics.currency,
      )
      .map((account) => account.id);
    const currencyCompletenessBlocked = unknownCurrencyAccountIds.length > 0;

    const providerEvidence = payload.providerEvidence.map((entry) => ({
      ...entry,
      absoluteChange: metricAbsoluteChange(entry.current, entry.comparison),
    }));
    const accountEvidence = payload.accountEvidence.map((entry) => ({
      ...entry,
      absoluteChange: metricAbsoluteChange(entry.current, entry.comparison),
    }));

    const scopedProviders = new Set(payload.accounts.map((account) => account.provider));
    const scopedQualityItems = payload.dataQuality.items.filter((item) => {
      if (!query.accountId) return true;
      // Scope resolution already proves the requested account exists in canonical selected-account
      // truth. A provider-wide warning about some other selected external account must not poison
      // this explicit account read merely because both accounts share a provider.
      if (item.code === 'SELECTED_ACCOUNT_EVIDENCE_MISSING') return false;
      return item.provider === undefined || scopedProviders.has(item.provider);
    });
    const dataQualityItems: UnifiedDataQualityItem[] = [
      ...scopedQualityItems,
      ...(foreignCurrencyAccountIds.length > 0
        ? [
            {
              code: 'CURRENCY_MISMATCH',
              status: 'WARNING' as const,
              surface: 'BLENDED_ECONOMICS',
              message:
                'Selected advertising accounts with non-store currency are excluded from store-currency blended economics.',
              metrics: {
                storeCurrency: payload.blendedEconomics.currency,
                excludedAccountIds: foreignCurrencyAccountIds,
              },
            },
          ]
        : []),
    ];
    const comparisonComplete =
      accountEvidence.length > 0 &&
      accountEvidence.every((entry) => entry.comparison.evidenceAvailable);
    const confidence = unifiedEvidenceConfidence(dataQualityItems, comparisonComplete);

    const current = currencyCompletenessBlocked
      ? {
          ...payload.blendedEconomics.current,
          compatiblePaidSpend: null,
          mer: null,
          adSpendRatio: null,
          contributionAfterAdvertising: null,
          evidenceAvailable: false,
          unknownCurrencyAccountIds,
          excludedCurrencyAccountIds: foreignCurrencyAccountIds,
        }
      : {
          ...payload.blendedEconomics.current,
          unknownCurrencyAccountIds: [] as string[],
          excludedCurrencyAccountIds: foreignCurrencyAccountIds,
        };
    const comparison = currencyCompletenessBlocked
      ? {
          ...payload.blendedEconomics.comparison,
          compatiblePaidSpend: null,
          mer: null,
          adSpendRatio: null,
          contributionAfterAdvertising: null,
          evidenceAvailable: false,
          unknownCurrencyAccountIds,
          excludedCurrencyAccountIds: foreignCurrencyAccountIds,
        }
      : {
          ...payload.blendedEconomics.comparison,
          unknownCurrencyAccountIds: [] as string[],
          excludedCurrencyAccountIds: foreignCurrencyAccountIds,
        };

    return {
      ...payload,
      providerEvidence,
      accountEvidence,
      dataQuality: {
        ...payload.dataQuality,
        confidence,
        items: dataQualityItems,
        confidenceMethodology:
          'LOW for blocking evidence gaps; MEDIUM for relevant warnings or incomplete comparison evidence; HIGH when required current/comparison evidence is complete with no relevant warnings. Unsupported deduplicated reach does not lower confidence for metrics that do not require reach.',
      },
      blendedEconomics: {
        ...payload.blendedEconomics,
        current,
        comparison,
        absoluteChange: {
          compatiblePaidSpend: delta(
            current.compatiblePaidSpend,
            comparison.compatiblePaidSpend,
          ),
          mer: delta(current.mer, comparison.mer),
          adSpendRatio: delta(current.adSpendRatio, comparison.adSpendRatio),
          contributionAfterAdvertising: delta(
            current.contributionAfterAdvertising,
            comparison.contributionAfterAdvertising,
          ),
        },
        limitations: [
          ...(currencyCompletenessBlocked
            ? [
                'Blended economics are unavailable because at least one selected advertising account has unknown currency.',
              ]
            : []),
          ...(foreignCurrencyAccountIds.length > 0
            ? [
                'Selected advertising accounts whose currency differs from the Shopify store currency are excluded from store-currency blended economics.',
              ]
            : []),
          'Provider-attributed conversion value remains provider evidence and is never substituted for Shopify revenue.',
          'Missing required paid-media evidence is not treated as zero.',
        ],
      },
    };
  }
}

export const unifiedAdvertisingIntelligenceService =
  new UnifiedAdvertisingIntelligenceService();
