import { AppError } from '../../errors/app-error.js';
import { completedWindow } from './intelligence.dates.js';
import {
  buildCampaignEvidence,
  buildCreativeEvidence,
  buildProductEvidence,
} from './intelligence.metrics.js';
import { IntelligenceRepository } from './intelligence.repository.js';
import {
  campaignEfficiencyRule,
  creativeFatigueRule,
  inventorySpendConflictRule,
  marginTrapRule,
  paidCommerceMismatchRule,
  underexposedProductRule,
} from './intelligence.rules.js';
import type {
  DataQualityEvidence,
  RecommendationCategory,
  RecommendationDraft,
  RecommendationEntityType,
  RecommendationSeverity,
  RecommendationStatus,
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

function qualityRecommendation(
  storeId: string,
  item: DataQualityEvidence,
  window: { start: Date; end: Date },
): RecommendationDraft | null {
  if (item.status === 'HEALTHY') return null;

  const suggestedAction = (() => {
    switch (item.code) {
      case 'SHOPIFY_HISTORY_LIMITED':
        return 'Keep the history limitation visible until extended Shopify order access is available.';
      case 'SHOPIFY_SYNC_STALE':
        return 'Refresh the Shopify connection before relying on recent commerce comparisons.';
      case 'META_SYNC_STALE':
      case 'META_INSIGHTS_MISSING':
        return 'Refresh Meta insights before relying on recent advertising comparisons.';
      case 'PRODUCT_AD_MAPPING_LOW':
        return 'Review Product × Ads mappings before using cross-channel product recommendations.';
      case 'PRODUCT_COST_COVERAGE_LOW':
        return 'Add or correct product costs before relying on contribution-after-ads recommendations.';
      case 'INVENTORY_DATA_MISSING':
        return 'Reconcile Shopify inventory before using inventory-aware advertising recommendations.';
      default:
        return 'Review the affected integration or data source before acting on dependent recommendations.';
    }
  })();

  const blocked = item.status === 'BLOCKED';
  return {
    ruleId: `data_quality_${item.code.toLowerCase()}`,
    ruleVersion: '1',
    category: 'DATA_QUALITY',
    severity: blocked ? 'HIGH' : 'LOW',
    entityType: 'STORE',
    entityId: storeId,
    externalEntityId: null,
    title: item.message,
    summary: `Stride reduced or blocked dependent intelligence because ${item.message.toLowerCase()}`,
    suggestedAction,
    impactScore: blocked ? 0.8 : 0.35,
    confidenceScore: 1,
    urgencyScore: blocked ? 0.8 : 0.35,
    observationStart: window.start,
    observationEnd: window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'STRIDE_DATA_QUALITY',
      code: item.code,
      surface: item.surface,
      status: item.status,
      metrics: item.metrics ?? {},
    },
  };
}

export class IntelligenceService {
  constructor(private readonly repository: IntelligenceRepository = new IntelligenceRepository()) {}

  async evaluate(storeId: string, now = new Date()) {
    const store = await this.repository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const settings = store.intelligenceSettings ?? (await this.repository.getOrCreateSettings(storeId));
    const current = completedWindow(now, store.ianaTimezone, DECISION_WINDOW_DAYS);
    const comparison = completedWindow(
      now,
      store.ianaTimezone,
      DECISION_WINDOW_DAYS,
      DECISION_WINDOW_DAYS,
    );
    const productWindow = completedWindow(now, store.ianaTimezone, PRODUCT_WINDOW_DAYS);

    const [metaRows, commerceRows, mappings, inventoryRows, freshness] = await Promise.all([
      this.repository.getMetaEvidenceRows(storeId, productWindow.metaFrom, current.metaTo),
      this.repository.getCommerceRows(storeId, productWindow.instantFrom, productWindow.instantTo),
      this.repository.getActiveProductMappings(storeId),
      this.repository.getInventoryLevels(storeId),
      this.repository.getFreshness(storeId),
    ]);
    const variantIds = [
      ...new Set(
        commerceRows
          .map((row) => row.variantId)
          .filter((variantId): variantId is string => variantId !== null),
      ),
    ];
    const costs = await this.repository.getVariantCosts(
      storeId,
      variantIds,
      productWindow.instantFrom,
      productWindow.instantTo,
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
    const productResult = buildProductEvidence({
      commerceRows,
      costRows: costs,
      mappings,
      inventoryRows,
      metaRows,
      storeCurrency: store.currencyCode,
      inventoryTrusted: settings.inventoryMode === 'TRUSTED',
      windowDays: PRODUCT_WINDOW_DAYS,
    });

    const drafts: RecommendationDraft[] = [];
    for (const campaign of campaigns) {
      const recommendation = campaignEfficiencyRule(campaign);
      if (recommendation) drafts.push(recommendation);
    }
    for (const creative of creatives) {
      const recommendation = creativeFatigueRule(creative);
      if (recommendation) drafts.push(recommendation);
    }
    const productRuleWindow = {
      start: productWindow.metaFrom,
      end: productWindow.metaTo,
    };
    for (const product of productResult.products) {
      const productDrafts = [
        underexposedProductRule(product, productRuleWindow),
        paidCommerceMismatchRule(product, productRuleWindow),
        marginTrapRule(product, productRuleWindow),
        inventorySpendConflictRule(product, productRuleWindow),
      ];
      for (const draft of productDrafts) if (draft) drafts.push(draft);
    }

    const dataQuality = this.buildDataQuality({
      store,
      settings,
      metaRowsCount: metaRows.length,
      inventoryRowsCount: inventoryRows.length,
      productResult,
      freshness,
      now,
    });
    for (const item of dataQuality) {
      const recommendation = qualityRecommendation(storeId, item, productRuleWindow);
      if (recommendation) drafts.push(recommendation);
    }

    const [recommendations, qualitySnapshots] = await Promise.all([
      this.repository.syncRecommendations(storeId, drafts),
      this.repository.recordDataQualitySnapshots(storeId, dataQuality),
    ]);

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
        metaRows: metaRows.length,
        commerceRows: commerceRows.length,
        mappingCoverage: productResult.mappingCoverage,
        costCoverage: this.overallCostCoverage(productResult.products),
      },
      recommendations,
      dataQualitySnapshots: qualitySnapshots,
    };
  }

  listRecommendations(
    storeId: string,
    input: {
      status?: RecommendationStatus;
      category?: RecommendationCategory;
      severity?: RecommendationSeverity;
      entityType?: RecommendationEntityType;
      page: number;
      limit: number;
    },
  ) {
    return this.repository.listRecommendations(storeId, input);
  }

  async getRecommendation(storeId: string, id: string) {
    const recommendation = await this.repository.getRecommendation(storeId, id);
    if (!recommendation) {
      throw new AppError('Recommendation not found', 404, 'RECOMMENDATION_NOT_FOUND');
    }
    return recommendation;
  }

  async setRecommendationStatus(
    storeId: string,
    id: string,
    status: RecommendationStatus,
    actorUserId: string,
  ) {
    const updated = await this.repository.setRecommendationStatus(storeId, id, status, actorUserId);
    if (!updated) throw new AppError('Recommendation not found', 404, 'RECOMMENDATION_NOT_FOUND');
    return updated;
  }

  getSettings(storeId: string) {
    return this.repository.getOrCreateSettings(storeId);
  }

  updateInventoryMode(storeId: string, mode: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE') {
    return this.repository.updateInventoryMode(storeId, mode);
  }

  listDataQuality(storeId: string, limit = 100) {
    return this.repository.listRecentDataQuality(storeId, limit);
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
    settings: NonNullable<
      NonNullable<Awaited<ReturnType<IntelligenceRepository['getStoreContext']>>>['intelligenceSettings']
    >;
    metaRowsCount: number;
    inventoryRowsCount: number;
    productResult: ReturnType<typeof buildProductEvidence>;
    freshness: Awaited<ReturnType<IntelligenceRepository['getFreshness']>>;
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

    const metaFreshness = input.freshness.latestInsight?.syncedAt ?? meta?.lastSyncedAt ?? null;
    const metaStaleHours = ageHours(metaFreshness, input.now);
    if (meta && meta.status === 'ACTIVE' && metaStaleHours !== null && metaStaleHours > STALE_SYNC_HOURS) {
      evidence.push({
        code: 'META_SYNC_STALE',
        status: 'WARNING',
        surface: 'META_ADVERTISING',
        message: 'Meta advertising synchronization is older than the freshness window.',
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
        message: 'Product × Ads mapping coverage is too low for broad cross-channel conclusions.',
        metrics: {
          mappingCoverage: input.productResult.mappingCoverage,
          requiredCoverage: MIN_MAPPING_COVERAGE,
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

    if (input.settings.inventoryMode === 'TRUSTED' && input.inventoryRowsCount === 0) {
      evidence.push({
        code: 'INVENTORY_DATA_MISSING',
        status: 'BLOCKED',
        surface: 'SHOPIFY_INVENTORY',
        message: 'Inventory is marked trusted but no current Shopify inventory levels are available.',
      });
    } else if (input.settings.inventoryMode === 'UNRELIABLE') {
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
