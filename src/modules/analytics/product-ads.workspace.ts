import { AppError } from '../../errors/app-error.js';
import {
  UnifiedAdvertisingRepository,
  type UnifiedAdvertisingAccountRow,
} from '../advertising/unified-advertising.repository.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { metricChanges, percentChange, type MetaMetrics, type ProductMetrics } from './analytics.metrics.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from './analytics.schema.js';
import { LegacyProductAdsCompatibilityRepository } from './legacy-product-ads-compatibility.repository.js';
import { UnifiedProductAdsRepository } from './unified-product-ads.repository.js';
import {
  UnifiedProductAdsService,
  unifiedProductAdsService,
} from './unified-product-ads.service.js';

const MIN_AUTOMATIC_MAPPING_CONFIDENCE = 0.7;

type UnifiedList = Awaited<ReturnType<UnifiedProductAdsService['list']>>;
type UnifiedItem = UnifiedList['items'][number];
type UnifiedDetail = Awaited<ReturnType<UnifiedProductAdsService['detail']>>;
type UnifiedAdvertisingPeriod = UnifiedItem['current']['advertising'];
type UnifiedCommercePeriod = UnifiedItem['current']['commerce'];
type UnifiedSummaryPeriod = UnifiedList['summary']['current'];
type ActiveMapping = Awaited<ReturnType<UnifiedProductAdsRepository['activeMappings']>>[number];
type CommerceTotals = { CURRENT: number; COMPARISON: number };

function legacyCommerce(period: UnifiedCommercePeriod): ProductMetrics & { evidenceAvailable: boolean } {
  return {
    evidenceAvailable: period.evidenceAvailable,
    orderCount: period.orderCount ?? 0,
    soldUnits: period.soldUnits ?? 0,
    refundedUnits: period.refundedUnits ?? 0,
    netUnits: period.netUnits ?? 0,
    productRevenue: period.productRevenue ?? 0,
    refunds: period.refunds ?? 0,
    netProductRevenue: period.netProductRevenue ?? 0,
    cogs: period.cogs,
    costCoverage: period.costCoverage ?? 0,
    contributionBeforeAds: period.contributionBeforeAds,
  };
}

function legacyAdvertising(
  period: UnifiedAdvertisingPeriod,
): MetaMetrics & { evidenceAvailable: boolean } {
  const spend = period.spend ?? 0;
  const impressions = period.impressions ?? 0;
  const clicks = period.clicks ?? 0;
  const purchases = period.providerConversions;
  const purchaseValue = period.providerConversionValue;
  return {
    evidenceAvailable: period.evidenceAvailable,
    sourceRows: period.evidenceAvailable ? 1 : 0,
    spend,
    impressions,
    clicks,
    purchases,
    purchaseValue,
    providerRoas: purchaseValue !== null && spend > 0 ? purchaseValue / spend : null,
    cpa: purchases !== null && purchases > 0 ? spend / purchases : null,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    averageDailyFrequency: null,
  };
}

function unavailableMetricChanges<T extends Record<string, number | null>>(metrics: T): T {
  return Object.fromEntries(Object.keys(metrics).map((key) => [key, null])) as T;
}

function legacyAdvertisingChanges(
  current: ReturnType<typeof legacyAdvertising>,
  comparison: ReturnType<typeof legacyAdvertising>,
) {
  const currentMetrics: MetaMetrics = current;
  const comparisonMetrics: MetaMetrics = comparison;
  return current.evidenceAvailable && comparison.evidenceAvailable
    ? metricChanges(currentMetrics, comparisonMetrics)
    : unavailableMetricChanges(currentMetrics);
}

function legacyMapping(item: UnifiedItem) {
  return {
    confidence: item.mapping.confidence,
    mappedAdCount: item.mapping.exactMappedAdCount,
    merchantConfirmed: item.mapping.merchantConfirmed,
    sources: [
      ...new Set(
        item.mapping.evidence
          .map((evidence) => evidence.source)
          .filter((source): source is string => typeof source === 'string'),
      ),
    ].sort(),
  };
}

function legacySummaryPeriod(
  period: UnifiedSummaryPeriod,
  netProductRevenue: number,
) {
  return {
    evidenceAvailable: period.evidenceAvailable,
    netProductRevenue,
    // Legacy numeric fields are retained for compatibility, but evidenceAvailable is authoritative.
    metaSpend: period.compatiblePaidSpend ?? 0,
    exactMappedSpend: period.exactMappedSpend,
    sharedSpend: period.sharedSpend,
    ambiguousObservedSpend: period.ambiguousObservedSpend,
    unmappedSpend: period.unmappedSpend ?? 0,
    mappingCoverage: period.mappingCoverage ?? 0,
    missingAccountIds: period.missingAccountIds,
    excludedMetaSpend: [] as Array<{ currency: string; spend: number }>,
  };
}

export class ProductAdsWorkspace {
  constructor(
    private readonly analyticsRepository: AnalyticsRepository = new AnalyticsRepository(),
    private readonly advertisingRepository: UnifiedAdvertisingRepository =
      new UnifiedAdvertisingRepository(),
    private readonly unifiedService: UnifiedProductAdsService = unifiedProductAdsService,
    private readonly unifiedRepository: UnifiedProductAdsRepository = new UnifiedProductAdsRepository(),
    private readonly compatibilityRepository: LegacyProductAdsCompatibilityRepository =
      new LegacyProductAdsCompatibilityRepository(),
  ) {}

  async list(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const context = await this.context(storeId, query, now);
    const [unified, commerceTotals] = await Promise.all([
      this.unifiedService.list(
        storeId,
        {
          from: query.from,
          to: query.to,
          days: query.days,
          provider: 'META',
          accountId: context.canonicalAccountId,
          page: query.page,
          limit: query.limit,
        },
        now,
      ),
      this.compatibilityRepository.netProductRevenueTotals({
        storeId,
        currency: context.store.currencyCode,
        currentFrom: context.windows.current.instantFrom,
        currentTo: context.windows.current.instantTo,
        comparisonFrom: context.windows.comparison.instantFrom,
        comparisonTo: context.windows.comparison.instantTo,
      }),
    ]);

    return {
      ...this.header(unified),
      summary: this.summary(unified, commerceTotals),
      items: unified.items.map((item) => this.item(item, unified, commerceTotals)),
      pagination: unified.pagination,
    };
  }

  async detail(storeId: string, productId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const context = await this.context(storeId, query, now);
    const [unified, commerceTotals, mappings] = await Promise.all([
      this.unifiedService.detail(
        storeId,
        productId,
        {
          from: query.from,
          to: query.to,
          days: query.days,
          provider: 'META',
          accountId: context.canonicalAccountId,
        },
        now,
      ),
      this.compatibilityRepository.netProductRevenueTotals({
        storeId,
        currency: context.store.currencyCode,
        currentFrom: context.windows.current.instantFrom,
        currentTo: context.windows.current.instantTo,
        comparisonFrom: context.windows.comparison.instantFrom,
        comparisonTo: context.windows.comparison.instantTo,
      }),
      this.unifiedRepository.activeMappings(
        storeId,
        context.metaAccounts.map((account) => account.id),
        [productId],
      ),
    ]);

    return {
      ...this.header(unified),
      summary: this.summary(unified, commerceTotals),
      ...this.item(unified as UnifiedItem, unified, commerceTotals),
      mappings: this.mappingEvidence(unified, mappings),
    };
  }

  private async context(storeId: string, query: AnalyticsRangeQuery, now: Date) {
    const store = await this.analyticsRepository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const states = await this.advertisingRepository.connectionStates(storeId);
    const accounts = await this.advertisingRepository.selectedAccounts(storeId, states);
    const metaAccounts = accounts.filter((account) => account.provider === 'META');
    let canonicalAccountId: string | undefined;
    if (query.accountId) {
      const account = metaAccounts.find(
        (candidate) =>
          candidate.providerEntityId === query.accountId || candidate.id === query.accountId,
      );
      if (!account) {
        throw new AppError(
          'Meta ad account is not selected for this store',
          400,
          'META_AD_ACCOUNT_NOT_SELECTED',
        );
      }
      canonicalAccountId = account.id;
    }
    return { store, windows, metaAccounts, canonicalAccountId };
  }

  private header(unified: UnifiedList | UnifiedDetail) {
    return {
      window: unified.window,
      currency: unified.currency,
      methodology: {
        commerce: 'SHOPIFY_PRODUCT_ORDER_COHORT_NET_OF_LINKED_REFUNDS',
        advertising: 'META_PROVIDER_ATTRIBUTION_SAME_STORE_CURRENCY_ONLY',
        mapping: 'EXACT_SINGLE_PRODUCT_MAPPING_ONLY',
        mappingSnapshot: 'CURRENT_ACTIVE_MAPPING_APPLIED_TO_SELECTED_HISTORY',
        contribution: 'SHOPIFY_CONTRIBUTION_BEFORE_ADS_MINUS_MAPPED_META_SPEND',
        profitLabel: 'CONTRIBUTION_AFTER_ADS_NOT_NET_PROFIT',
      },
      mappingPolicy: {
        minimumAutomaticConfidence: MIN_AUTOMATIC_MAPPING_CONFIDENCE,
        merchantConfirmedOverridesAutomatic: true,
        selectedMetaAccountsOnly: true,
        multiProductAdsExcluded: true,
        sameProductMultiVariantAdsAccepted: true,
      },
      compatibility: {
        deprecated: true,
        authoritativeEndpoint: '/analytics/product-ads/unified',
        computation: 'UNIFIED_PRODUCT_ADS_SERVICE',
      },
    };
  }

  private summary(
    unified: Pick<UnifiedList, 'summary'>,
    commerceTotals: CommerceTotals,
  ) {
    const current = legacySummaryPeriod(unified.summary.current, commerceTotals.CURRENT);
    const comparison = legacySummaryPeriod(
      unified.summary.comparison,
      commerceTotals.COMPARISON,
    );
    return {
      current,
      comparison,
      change: {
        netProductRevenue: percentChange(current.netProductRevenue, comparison.netProductRevenue),
        metaSpend:
          current.evidenceAvailable && comparison.evidenceAvailable
            ? percentChange(current.metaSpend, comparison.metaSpend)
            : null,
        exactMappedSpend: percentChange(current.exactMappedSpend, comparison.exactMappedSpend),
        unmappedSpend:
          current.evidenceAvailable && comparison.evidenceAvailable
            ? percentChange(current.unmappedSpend, comparison.unmappedSpend)
            : null,
        mappingCoverage:
          current.evidenceAvailable && comparison.evidenceAvailable
            ? percentChange(current.mappingCoverage, comparison.mappingCoverage)
            : null,
      },
    };
  }

  private item(
    item: UnifiedItem,
    unified: Pick<UnifiedList, 'summary'>,
    commerceTotals: CommerceTotals,
  ) {
    const currentCommerce = legacyCommerce(item.current.commerce);
    const comparisonCommerce = legacyCommerce(item.comparison.commerce);
    const currentCommerceMetrics: ProductMetrics = currentCommerce;
    const comparisonCommerceMetrics: ProductMetrics = comparisonCommerce;
    const currentAdvertising = legacyAdvertising(item.current.advertising);
    const comparisonAdvertising = legacyAdvertising(item.comparison.advertising);
    const currentPaidTotal = unified.summary.current.compatiblePaidSpend;
    const comparisonPaidTotal = unified.summary.comparison.compatiblePaidSpend;
    const currentRevenueShare =
      commerceTotals.CURRENT > 0
        ? currentCommerce.netProductRevenue / commerceTotals.CURRENT
        : 0;
    const comparisonRevenueShare =
      commerceTotals.COMPARISON > 0
        ? comparisonCommerce.netProductRevenue / commerceTotals.COMPARISON
        : 0;
    const currentMappedSpendShare =
      currentPaidTotal !== null && currentPaidTotal > 0 && item.current.advertising.spend !== null
        ? item.current.advertising.spend / currentPaidTotal
        : currentPaidTotal === 0
          ? 0
          : null;
    const comparisonMappedSpendShare =
      comparisonPaidTotal !== null &&
      comparisonPaidTotal > 0 &&
      item.comparison.advertising.spend !== null
        ? item.comparison.advertising.spend / comparisonPaidTotal
        : comparisonPaidTotal === 0
          ? 0
          : null;
    const currentDerived = {
      contributionAfterAds: item.current.intelligence.contributionAfterAds,
      revenueShare: currentRevenueShare,
      mappedSpendShare: currentMappedSpendShare,
    };
    const comparisonDerived = {
      contributionAfterAds: item.comparison.intelligence.contributionAfterAds,
      revenueShare: comparisonRevenueShare,
      mappedSpendShare: comparisonMappedSpendShare,
    };

    return {
      product: item.product,
      mapping: legacyMapping(item),
      current: {
        commerce: currentCommerce,
        advertising: currentAdvertising,
        derived: currentDerived,
      },
      comparison: {
        commerce: comparisonCommerce,
        advertising: comparisonAdvertising,
        derived: comparisonDerived,
      },
      change: {
        commerce: metricChanges(currentCommerceMetrics, comparisonCommerceMetrics),
        advertising: legacyAdvertisingChanges(currentAdvertising, comparisonAdvertising),
        derived: {
          contributionAfterAds: percentChange(
            currentDerived.contributionAfterAds,
            comparisonDerived.contributionAfterAds,
          ),
          revenueShare: percentChange(
            currentDerived.revenueShare,
            comparisonDerived.revenueShare,
          ),
          mappedSpendShare: percentChange(
            currentDerived.mappedSpendShare,
            comparisonDerived.mappedSpendShare,
          ),
        },
      },
    };
  }

  private mappingEvidence(unified: UnifiedDetail, rows: ActiveMapping[]) {
    const exactAdIds = new Set(
      unified.mapping.evidence
        .filter((evidence) => evidence.mappingType === 'EXACT')
        .map((evidence) => evidence.ad.id),
    );
    const byAd = new Map<string, ActiveMapping[]>();
    for (const row of rows) {
      if (!exactAdIds.has(row.adId)) continue;
      const values = byAd.get(row.adId) ?? [];
      values.push(row);
      byAd.set(row.adId, values);
    }
    return [...byAd.values()].map((values) => {
      const first = values[0]!;
      const variants = new Map(
        values
          .filter((row) => row.variant !== null)
          .map((row) => [row.variant!.id, row.variant!] as const),
      );
      const confirmed = values.some((row) => row.merchantConfirmed);
      return {
        confidence: confirmed ? 1 : Math.max(...values.map((row) => row.confidence)),
        merchantConfirmed: confirmed,
        sources: [...new Set(values.map((row) => row.source))].sort(),
        ad: {
          id: first.ad.id,
          metaAdId: first.ad.providerEntityId,
          name: first.ad.name,
          campaign: {
            id: first.ad.campaign.id,
            metaCampaignId: first.ad.campaign.providerEntityId,
            name: first.ad.campaign.name,
          },
          adSet: first.ad.group
            ? {
                id: first.ad.group.id,
                metaAdSetId: first.ad.group.providerEntityId,
                name: first.ad.group.name,
              }
            : null,
          creative: null,
        },
        variants: [...variants.values()],
      };
    });
  }
}

export const productAdsWorkspace = new ProductAdsWorkspace();
