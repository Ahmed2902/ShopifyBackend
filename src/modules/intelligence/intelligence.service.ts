import { AppError } from '../../errors/app-error.js';
import { IntelligenceCommerceReadRepository } from './intelligence-commerce.read.repository.js';
import { completedWindow } from './intelligence.dates.js';
import {
  buildCampaignEvidence,
  buildCreativeEvidence,
  buildProductEvidenceFromAggregates,
} from './intelligence.metrics.js';
import { IntelligenceRepository } from './intelligence.repository.js';
import {
  campaignEfficiencyRule,
  creativeFatigueRule,
  inventorySpendConflictRule,
  marginTrapRule,
  paidCommerceMismatchRule,
  sharedExposureInventoryRule,
  underexposedProductRule,
} from './intelligence.rules.js';
import { buildSharedExposureEvidenceFromAggregates } from './shared-exposure.metrics.js';
import type {
  DataQualityEvidence,
  RecommendationDraft,
  RecommendationLimitation,
} from './intelligence.types.js';

const DECISION_WINDOW_DAYS = 7;
const PRODUCT_WINDOW_DAYS = 28;
const STALE_SYNC_HOURS = 48;
const MIN_MAPPING_COVERAGE = 0.6;
const MIN_COST_COVERAGE = 0.8;

function ageHours(value: Date | null | undefined, now: Date): number | null {
  if (!value) return null;
  return Math.max(0, (now.getTime() - value.getTime()) / 3_600_000);
}

function priority(recommendation: RecommendationDraft): number {
  return recommendation.impactScore * recommendation.confidenceScore * recommendation.urgencyScore;
}

function evidenceQuality(confidenceScore: number, limitations: RecommendationLimitation[]) {
  const severe = limitations.some((limitation) =>
    [
      'MAPPING_COVERAGE_VERY_LOW',
      'META_ACCOUNTS_NOT_SELECTED',
      'META_CONNECTION_BLOCKED',
      'META_INSIGHTS_MISSING',
      'META_SYNC_STALE',
      'SHOPIFY_CONNECTION_BLOCKED',
    ].includes(limitation.code),
  );
  if (!severe && confidenceScore >= 0.82) return 'HIGH' as const;
  if (confidenceScore >= 0.58) return 'MEDIUM' as const;
  return 'LOW' as const;
}

export class IntelligenceService {
  constructor(
    private readonly repository: IntelligenceRepository = new IntelligenceRepository(),
    private readonly commerceReadRepository: IntelligenceCommerceReadRepository =
      new IntelligenceCommerceReadRepository(),
  ) {}

  async snapshot(storeId: string, now = new Date()) {
    const store = await this.repository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const current = completedWindow(now, store.ianaTimezone, DECISION_WINDOW_DAYS);
    const comparison = completedWindow(
      now,
      store.ianaTimezone,
      DECISION_WINDOW_DAYS,
      DECISION_WINDOW_DAYS,
    );
    const productWindow = completedWindow(now, store.ianaTimezone, PRODUCT_WINDOW_DAYS);
    const selectedMetaAccounts = store.metaConnection?.selectedAdAccountIds ?? [];

    const [
      metaRows,
      commerceRows,
      mappings,
      inventoryRows,
      successfulOrderHistorySync,
      latestMetaInsightSync,
    ] = await Promise.all([
      this.repository.getMetaEvidenceRows({
        storeId,
        selectedAccountIds: selectedMetaAccounts,
        productFrom: productWindow.metaFrom,
        currentFrom: current.metaFrom,
        currentTo: current.metaTo,
        comparisonFrom: comparison.metaFrom,
        comparisonTo: comparison.metaTo,
      }),
      this.commerceReadRepository.getProductEvidenceAggregates({
        storeId,
        currency: store.currencyCode,
        from: productWindow.instantFrom,
        to: productWindow.instantTo,
      }),
      this.repository.getActiveProductMappings(storeId, selectedMetaAccounts),
      this.repository.getInventoryLevels(storeId),
      this.repository.getLatestOrderHistorySync(storeId),
      this.repository.getLatestMetaInsightSyncedAt(storeId, selectedMetaAccounts),
    ]);

    const metaSourceRowCount = metaRows.reduce(
      (sum, row) => sum + (Number.isFinite(row.sourceRowCount) ? row.sourceRowCount : 1),
      0,
    );
    const commerceSourceRowCount = commerceRows.reduce(
      (sum, row) => sum + row.sourceOrderLineCount,
      0,
    );
    const observedAdIds = [
      ...new Set(
        metaRows
          .map((row) => row.ad?.id ?? null)
          .filter((adId): adId is string => adId !== null),
      ),
    ];
    const sharedTargets = await this.repository.getSharedExposureTargets(
      storeId,
      selectedMetaAccounts,
      observedAdIds,
    );

    const campaigns = buildCampaignEvidence(
      metaRows,
      current.metaFrom,
      current.metaTo,
      comparison.metaFrom,
      comparison.metaTo,
    );
    const creatives = buildCreativeEvidence(
      metaRows,
      current.metaFrom,
      current.metaTo,
      comparison.metaFrom,
      comparison.metaTo,
    );
    const productResult = buildProductEvidenceFromAggregates({
      commerceRows,
      mappings,
      inventoryRows,
      metaRows,
      storeCurrency: store.currencyCode,
      inventoryTrusted: store.inventoryIntelligenceMode === 'TRUSTED',
      windowDays: PRODUCT_WINDOW_DAYS,
    });
    const sharedExposure = buildSharedExposureEvidenceFromAggregates({
      targets: sharedTargets,
      metaRows,
      commerceRows,
      inventoryRows,
      inventoryTrusted: store.inventoryIntelligenceMode === 'TRUSTED',
      windowDays: PRODUCT_WINDOW_DAYS,
    });

    const recommendations: RecommendationDraft[] = [];
    for (const campaign of campaigns) {
      const result = campaignEfficiencyRule(campaign);
      if (result) recommendations.push(result);
    }
    for (const creative of creatives) {
      const result = creativeFatigueRule(creative);
      if (result) recommendations.push(result);
    }

    const shopifyCommerceUsable =
      store.shopifyConnection?.status === 'ACTIVE' &&
      (commerceSourceRowCount > 0 || successfulOrderHistorySync?.status === 'SUCCEEDED');
    const productRuleWindow = { start: productWindow.metaFrom, end: productWindow.metaTo };
    for (const product of productResult.products) {
      const results = [
        underexposedProductRule(product, productRuleWindow),
        shopifyCommerceUsable ? paidCommerceMismatchRule(product, productRuleWindow) : null,
        marginTrapRule(product, productRuleWindow),
        inventorySpendConflictRule(product, productRuleWindow),
      ];
      for (const result of results) if (result) recommendations.push(result);
    }
    for (const exposure of sharedExposure) {
      const result = sharedExposureInventoryRule(exposure, productRuleWindow);
      if (result) recommendations.push(result);
    }

    const latestMetaSyncedAt = latestMetaInsightSync?.syncedAt ?? null;
    const dataQuality = this.buildDataQuality({
      store,
      metaRowsCount: metaSourceRowCount,
      latestMetaSyncedAt,
      inventoryRowsCount: inventoryRows.length,
      productResult,
      now,
    });
    const contextualRecommendations = this.applyDataQualityContext(recommendations, dataQuality);

    return {
      evaluatedAt: now,
      windows: {
        decision: { from: current.fromDate, to: current.toDate },
        comparison: { from: comparison.fromDate, to: comparison.toDate },
        product: { from: productWindow.fromDate, to: productWindow.toDate },
      },
      evidence: {
        campaigns: campaigns.length,
        creatives: creatives.length,
        products: productResult.products.length,
        sharedExposures: sharedExposure.length,
        metaRows: metaSourceRowCount,
        commerceRows: commerceSourceRowCount,
        shopifyCommerceUsable,
        mappingCoverage: productResult.mappingCoverage,
        costCoverage: this.overallCostCoverage(productResult.products),
      },
      recommendations: contextualRecommendations
        .map((recommendation) => ({ ...recommendation, priority: priority(recommendation) }))
        .sort((left, right) => right.priority - left.priority),
      dataQuality,
    };
  }

  async getSettings(storeId: string) {
    const settings = await this.repository.getSettings(storeId);
    if (!settings) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return settings;
  }

  async updateInventoryMode(storeId: string, mode: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE') {
    const settings = await this.repository.getSettings(storeId);
    if (!settings) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return this.repository.updateInventoryMode(storeId, mode);
  }

  private applyDataQualityContext(
    recommendations: RecommendationDraft[],
    dataQuality: DataQualityEvidence[],
  ): RecommendationDraft[] {
    const warningByCode = new Map(
      dataQuality
        .filter((item) => item.status !== 'HEALTHY')
        .map((item) => [item.code, item] as const),
    );

    return recommendations.map((recommendation) => {
      const additions: RecommendationLimitation[] = [];
      const add = (code: string) => {
        const warning = warningByCode.get(code);
        if (!warning || recommendation.limitations.some((item) => item.code === code)) return;
        additions.push({ code, message: warning.message });
      };

      add('META_CONNECTION_BLOCKED');
      add('META_ACCOUNTS_NOT_SELECTED');
      add('META_INSIGHTS_MISSING');
      add('META_SYNC_STALE');

      const usesShopify = recommendation.attributionPrecision !== 'META_PROVIDER';
      if (usesShopify) {
        add('SHOPIFY_CONNECTION_BLOCKED');
        add('SHOPIFY_HISTORY_LIMITED');
        add('SHOPIFY_SYNC_STALE');
      }

      if (recommendation.attributionPrecision === 'EXACT_PRODUCT') {
        add('PRODUCT_AD_MAPPING_LOW');
        add('META_CURRENCY_MISMATCH');
      }

      if (additions.length === 0) return recommendation;

      const limitations = [...recommendation.limitations, ...additions];
      const confidenceScore = Math.max(
        0,
        Math.min(1, recommendation.confidenceScore * 0.92 ** additions.length),
      );
      return {
        ...recommendation,
        confidenceScore,
        evidenceQuality: evidenceQuality(confidenceScore, limitations),
        limitations,
      };
    });
  }

  private overallCostCoverage(products: Array<{ units: number; costCoverage: number }>): number {
    const totalUnits = products.reduce((sum, product) => sum + product.units, 0);
    if (totalUnits <= 0) return 0;
    return (
      products.reduce((sum, product) => sum + product.units * product.costCoverage, 0) / totalUnits
    );
  }

  private buildDataQuality(input: {
    store: NonNullable<Awaited<ReturnType<IntelligenceRepository['getStoreContext']>>>;
    metaRowsCount: number;
    latestMetaSyncedAt: Date | null;
    inventoryRowsCount: number;
    productResult: ReturnType<typeof buildProductEvidenceFromAggregates>;
    now: Date;
  }): DataQualityEvidence[] {
    const evidence: DataQualityEvidence[] = [];
    const shopify = input.store.shopifyConnection;
    const meta = input.store.metaConnection;

    if (!shopify || shopify.status !== 'ACTIVE') {
      evidence.push({
        code: 'SHOPIFY_CONNECTION_BLOCKED',
        status: 'BLOCKED',
        surface: 'SHOPIFY_COMMERCE',
        message: 'Shopify commerce data is not connected and active.',
      });
    } else {
      if (!shopify.scopes.includes('read_all_orders')) {
        evidence.push({
          code: 'SHOPIFY_HISTORY_LIMITED',
          status: 'WARNING',
          surface: 'SHOPIFY_COMMERCE',
          message: 'Shopify order history is limited to the authorized recent-order window.',
          metrics: { readAllOrdersGranted: false },
        });
      }
      const staleHours = ageHours(shopify.lastSyncedAt, input.now);
      if (staleHours !== null && staleHours > STALE_SYNC_HOURS) {
        evidence.push({
          code: 'SHOPIFY_SYNC_STALE',
          status: 'WARNING',
          surface: 'SHOPIFY_COMMERCE',
          message: 'Shopify synchronization is older than the freshness window.',
          metrics: { ageHours: staleHours, thresholdHours: STALE_SYNC_HOURS },
        });
      }
    }

    if (!meta || meta.status !== 'ACTIVE') {
      evidence.push({
        code: 'META_CONNECTION_BLOCKED',
        status: 'BLOCKED',
        surface: 'META_ADVERTISING',
        message: 'Meta advertising data is not connected and active.',
      });
    } else if (meta.selectedAdAccountIds.length === 0) {
      evidence.push({
        code: 'META_ACCOUNTS_NOT_SELECTED',
        status: 'BLOCKED',
        surface: 'META_ADVERTISING',
        message: 'No Meta ad account is selected for analysis.',
      });
    } else if (input.metaRowsCount === 0) {
      evidence.push({
        code: 'META_INSIGHTS_MISSING',
        status: 'BLOCKED',
        surface: 'META_ADVERTISING',
        message: 'No Meta daily insights are available for the analysis window.',
      });
    }

    const metaStaleHours = ageHours(input.latestMetaSyncedAt, input.now);
    if (meta && meta.status === 'ACTIVE' && metaStaleHours !== null && metaStaleHours > STALE_SYNC_HOURS) {
      evidence.push({
        code: 'META_SYNC_STALE',
        status: 'WARNING',
        surface: 'META_ADVERTISING',
        message: 'Meta Insights synchronization is older than the freshness window.',
        metrics: { ageHours: metaStaleHours, thresholdHours: STALE_SYNC_HOURS },
      });
    }

    if (
      input.productResult.totalMetaSpend > 0 &&
      input.productResult.mappingCoverage < MIN_MAPPING_COVERAGE
    ) {
      evidence.push({
        code: 'PRODUCT_AD_MAPPING_LOW',
        status: 'WARNING',
        surface: 'CROSS_CHANNEL_PRODUCT_ADS',
        message: 'Product × Ads mapping coverage is partial; broad cross-channel comparisons may be incomplete.',
        metrics: {
          mappingCoverage: input.productResult.mappingCoverage,
          referenceCoverage: MIN_MAPPING_COVERAGE,
        },
      });
    }

    if (input.productResult.suppressedMetaSpend > 0) {
      evidence.push({
        code: 'META_CURRENCY_MISMATCH',
        status: 'WARNING',
        surface: 'CROSS_CHANNEL_PRODUCT_ADS',
        message: 'Some Meta spend uses a different currency and is excluded from commerce comparisons.',
        metrics: { excludedSpend: input.productResult.suppressedMetaSpend },
      });
    }

    const costCoverage = this.overallCostCoverage(input.productResult.products);
    if (input.productResult.products.some((product) => product.units > 0) && costCoverage < MIN_COST_COVERAGE) {
      evidence.push({
        code: 'PRODUCT_COST_COVERAGE_LOW',
        status: 'WARNING',
        surface: 'SHOPIFY_ECONOMICS',
        message: 'Product cost coverage is too low for broad contribution-after-ads conclusions.',
        metrics: { costCoverage, requiredCoverage: MIN_COST_COVERAGE },
      });
    }

    if (input.store.inventoryIntelligenceMode === 'TRUSTED' && input.inventoryRowsCount === 0) {
      evidence.push({
        code: 'INVENTORY_DATA_MISSING',
        status: 'BLOCKED',
        surface: 'SHOPIFY_INVENTORY',
        message: 'Inventory is marked trusted but no current Shopify inventory levels are available.',
      });
    } else if (input.store.inventoryIntelligenceMode === 'UNRELIABLE') {
      evidence.push({
        code: 'INVENTORY_DATA_UNRELIABLE',
        status: 'WARNING',
        surface: 'SHOPIFY_INVENTORY',
        message: 'Inventory-aware recommendations are disabled because Shopify inventory is unreliable.',
      });
    }

    if (evidence.length === 0) {
      evidence.push({
        code: 'CORE_DATA_HEALTHY',
        status: 'HEALTHY',
        surface: 'CORE',
        message: 'Core Shopify and Meta evidence passed the current V1 data-quality checks.',
      });
    }
    return evidence;
  }
}

export const intelligenceService = new IntelligenceService();