import { pixelBehaviorService, type PixelBehaviorService } from '../pixel/behavior/pixel-behavior.service.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from '../analytics/analytics.schema.js';
import { buildStorefrontEvidence } from './storefront-intelligence.metrics.js';
import {
  cartAbandonmentDeteriorationRule,
  checkoutAbandonmentDeteriorationRule,
  highTrafficLowConversionRule,
  storefrontConversionDeteriorationRule,
  viewToCartDeteriorationRule,
} from './storefront-intelligence.rules.js';
import type { DataQualityEvidence, RecommendationDraft, StorefrontEvidence } from './intelligence.types.js';

const MAX_DIMENSION_ROWS = 100;

export class StorefrontIntelligenceService {
  constructor(private readonly behavior: PixelBehaviorService = pixelBehaviorService) {}

  async evaluate(storeId: string, range: { from: string; to: string }) {
    const overviewQuery: AnalyticsRangeQuery = { from: range.from, to: range.to, days: 7 };
    const listQuery: AnalyticsListQuery = {
      ...overviewQuery,
      page: 1,
      limit: MAX_DIMENSION_ROWS,
    };

    const [overview, products, landingPages] = await Promise.all([
      this.behavior.overview(storeId, overviewQuery),
      this.behavior.products(storeId, listQuery),
      this.behavior.landingPages(storeId, listQuery),
    ]);

    const window = {
      start: overview.window.current.instantFrom,
      end: overview.window.current.instantTo,
      comparisonStart: overview.window.comparison.instantFrom,
      comparisonEnd: overview.window.comparison.instantTo,
    };
    const quality = overview.dataQuality;
    const recommendations: RecommendationDraft[] = [];

    const storeEvidence = buildStorefrontEvidence({
      entityType: 'STORE',
      entityId: null,
      name: 'Storefront',
      current: overview.current,
      comparison: overview.comparison,
      quality,
    });
    this.pushStoreRules(recommendations, storeEvidence, window);

    for (const item of products.items) {
      const evidence = buildStorefrontEvidence({
        entityType: 'PRODUCT',
        entityId: item.product?.id ?? null,
        externalEntityId: item.product?.shopifyProductId ?? item.productExternalId,
        name: item.product?.title ?? item.productExternalId ?? item.variantExternalId ?? 'Unresolved product',
        current: item.current,
        comparison: item.comparison,
        quality: products.dataQuality,
      });
      const deterioration = viewToCartDeteriorationRule(evidence, window);
      const weakConversion = highTrafficLowConversionRule(evidence, window);
      if (deterioration) recommendations.push(deterioration);
      if (weakConversion) recommendations.push(weakConversion);
    }

    for (const item of landingPages.items) {
      const evidence = buildStorefrontEvidence({
        entityType: 'LANDING_PAGE',
        entityId: null,
        externalEntityId: item.dimensionKey,
        name: item.landingPageUrl ?? 'Privacy-normalized landing route',
        current: item.current,
        comparison: item.comparison,
        quality: landingPages.dataQuality,
      });
      const weakConversion = highTrafficLowConversionRule(evidence, window);
      if (weakConversion) recommendations.push(weakConversion);
    }

    return {
      recommendations,
      evidence: {
        qualityState: quality.state,
        sessions: overview.current.sessions,
        productRowsEvaluated: products.items.length,
        productRowsTotal: products.pagination.total,
        landingPageRowsEvaluated: landingPages.items.length,
        landingPageRowsTotal: landingPages.pagination.total,
        funnel: buildStorefrontEvidence({
          entityType: 'STORE',
          entityId: null,
          name: 'Storefront',
          current: overview.current,
          comparison: overview.comparison,
          quality,
        }),
      },
      dataQuality: this.dataQuality(quality, products.pagination.total, landingPages.pagination.total),
    };
  }

  private pushStoreRules(
    recommendations: RecommendationDraft[],
    evidence: StorefrontEvidence,
    window: { start: Date; end: Date; comparisonStart: Date; comparisonEnd: Date },
  ) {
    const results = [
      storefrontConversionDeteriorationRule(evidence, window),
      cartAbandonmentDeteriorationRule(evidence, window),
      checkoutAbandonmentDeteriorationRule(evidence, window),
      viewToCartDeteriorationRule(evidence, window),
    ];
    for (const result of results) if (result) recommendations.push(result);
  }

  private dataQuality(
    quality: { state: 'READY' | 'DEGRADED' | 'NOT_READY'; limitations: string[] },
    productTotal: number,
    landingTotal: number,
  ): DataQualityEvidence[] {
    const evidence: DataQualityEvidence[] = [];
    if (quality.state === 'NOT_READY') {
      evidence.push({
        code: 'PIXEL_BEHAVIOR_NOT_READY',
        status: 'BLOCKED',
        surface: 'STOREFRONT_BEHAVIOR',
        message: 'Stride Pixel behavior rollups are not ready for storefront decisions.',
        metrics: { limitations: quality.limitations },
      });
    } else if (quality.state === 'DEGRADED') {
      evidence.push({
        code: 'PIXEL_BEHAVIOR_DEGRADED',
        status: 'WARNING',
        surface: 'STOREFRONT_BEHAVIOR',
        message: 'Stride Pixel behavior is available with active rollup limitations.',
        metrics: { limitations: quality.limitations },
      });
    }
    if (productTotal > MAX_DIMENSION_ROWS) {
      evidence.push({
        code: 'PIXEL_PRODUCT_EVALUATION_BOUNDED',
        status: 'WARNING',
        surface: 'STOREFRONT_BEHAVIOR',
        message: `Storefront decisions evaluated the first ${MAX_DIMENSION_ROWS} product behavior rows in this snapshot.`,
        metrics: { evaluated: MAX_DIMENSION_ROWS, total: productTotal },
      });
    }
    if (landingTotal > MAX_DIMENSION_ROWS) {
      evidence.push({
        code: 'PIXEL_LANDING_EVALUATION_BOUNDED',
        status: 'WARNING',
        surface: 'STOREFRONT_BEHAVIOR',
        message: `Storefront decisions evaluated the first ${MAX_DIMENSION_ROWS} landing-page behavior rows in this snapshot.`,
        metrics: { evaluated: MAX_DIMENSION_ROWS, total: landingTotal },
      });
    }
    return evidence;
  }
}

export const storefrontIntelligenceService = new StorefrontIntelligenceService();
