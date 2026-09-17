import { analyticsWorkspace } from '../analytics/analytics.workspace.js';
import { pixelBehaviorService } from '../pixel/behavior/pixel-behavior.service.js';
import { intelligenceSnapshotCachedReads } from '../../lib/store-decision-cache.js';
import {
  discountDependencyRule,
  refundDeteriorationRule,
  returningCustomerDeteriorationRule,
} from './commerce-intelligence.rules.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';
import { mappingCoverageDegradedRule } from './mapping-intelligence.rules.js';
import {
  buildStorefrontDimensionEvidence,
  buildStorefrontEvidence,
} from './storefront-intelligence.evidence.js';
import {
  cartAbandonmentDeteriorationRule,
  checkoutAbandonmentDeteriorationRule,
  landingPageQualityDeteriorationRule,
  productConversionDeteriorationRule,
  storefrontConversionDeteriorationRule,
} from './storefront-intelligence.rules.js';
import type { RecommendationDraft } from './intelligence.types.js';

const INTELLIGENCE_WINDOW_DAYS = 7;
const DIMENSION_LIMIT = 100;

function priority(recommendation: RecommendationDraft) {
  return recommendation.impactScore * recommendation.confidenceScore * recommendation.urgencyScore;
}

function dayStart(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function dayEnd(value: string) {
  return new Date(`${value}T23:59:59.999Z`);
}

/**
 * Shared cache/coalescing boundary for the expensive deterministic snapshot.
 *
 * Keep this outside the HTTP controller so Overview, Reports and the Decisions screen reuse the
 * same cross-domain interpretation instead of each rebuilding storefront/commerce evidence.
 */
export class IntelligenceSnapshotReadService {
  constructor(private readonly service: IntelligenceService = intelligenceService) {}

  read(storeId: string, options: { fresh?: boolean } = {}) {
    return intelligenceSnapshotCachedReads.run(
      storeId,
      () => this.buildSnapshot(storeId),
      { fresh: options.fresh ?? false, versionScope: storeId },
    );
  }

  invalidate(storeId: string) {
    return intelligenceSnapshotCachedReads.invalidate(storeId);
  }

  private async buildSnapshot(storeId: string) {
    const query = { days: INTELLIGENCE_WINDOW_DAYS, page: 1, limit: DIMENSION_LIMIT };
    const [snapshot, storefrontResult, productsResult, landingPagesResult, commerceResult] =
      await Promise.allSettled([
        this.service.snapshot(storeId),
        pixelBehaviorService.overview(storeId, { days: INTELLIGENCE_WINDOW_DAYS }),
        pixelBehaviorService.products(storeId, query),
        pixelBehaviorService.landingPages(storeId, query),
        analyticsWorkspace.overview(storeId, { days: INTELLIGENCE_WINDOW_DAYS }),
      ]);
    if (snapshot.status === 'rejected') throw snapshot.reason;

    const extra: RecommendationDraft[] = [];
    let storefrontSessions: number | null = null;
    let storefrontQuality: string | null = null;
    let storefrontProductsEvaluated = 0;
    let landingPagesEvaluated = 0;

    if (storefrontResult.status === 'fulfilled') {
      const storefront = storefrontResult.value;
      storefrontSessions = storefront.current.sessions;
      storefrontQuality = storefront.dataQuality.state;
      const evidence = buildStorefrontEvidence({
        current: storefront.current,
        comparison: storefront.comparison,
        quality: storefront.dataQuality,
        observationStart: storefront.window.current.instantFrom,
        observationEnd: storefront.window.current.instantTo,
        comparisonStart: storefront.window.comparison.instantFrom,
        comparisonEnd: storefront.window.comparison.instantTo,
      });
      if (evidence) {
        for (const result of [
          cartAbandonmentDeteriorationRule(evidence),
          checkoutAbandonmentDeteriorationRule(evidence),
          storefrontConversionDeteriorationRule(evidence),
        ]) {
          if (result) extra.push(result);
        }
      }
    }

    if (productsResult.status === 'fulfilled') {
      const report = productsResult.value;
      storefrontProductsEvaluated = report.items.length;
      for (const item of report.items) {
        const evidence = buildStorefrontDimensionEvidence({
          entityType: 'PRODUCT',
          entityId: item.product?.id ?? null,
          externalEntityId:
            item.product?.shopifyProductId ?? item.productExternalId ?? item.variantExternalId,
          name:
            item.product?.title ??
            item.productExternalId ??
            item.variantExternalId ??
            'Unresolved product',
          current: item.current,
          comparison: item.comparison,
          quality: report.dataQuality,
          observationStart: report.window.current.instantFrom,
          observationEnd: report.window.current.instantTo,
          comparisonStart: report.window.comparison.instantFrom,
          comparisonEnd: report.window.comparison.instantTo,
        });
        if (!evidence) continue;
        const result = productConversionDeteriorationRule(evidence);
        if (result) extra.push(result);
      }
    }

    if (landingPagesResult.status === 'fulfilled') {
      const report = landingPagesResult.value;
      landingPagesEvaluated = report.items.length;
      for (const item of report.items) {
        const evidence = buildStorefrontDimensionEvidence({
          entityType: 'LANDING_PAGE',
          entityId: null,
          externalEntityId: item.landingPageUrl ?? item.dimensionKey,
          name: item.landingPageUrl ?? 'Privacy-normalized landing route',
          current: item.current,
          comparison: item.comparison,
          quality: report.dataQuality,
          observationStart: report.window.current.instantFrom,
          observationEnd: report.window.current.instantTo,
          comparisonStart: report.window.comparison.instantFrom,
          comparisonEnd: report.window.comparison.instantTo,
        });
        if (!evidence) continue;
        const result = landingPageQualityDeteriorationRule(evidence);
        if (result) extra.push(result);
      }
    }

    if (commerceResult.status === 'fulfilled') {
      const commerce = commerceResult.value;
      const currentKnown = commerce.commerce.current.newOrders + commerce.commerce.current.returningOrders;
      const comparisonKnown = commerce.commerce.comparison.newOrders + commerce.commerce.comparison.returningOrders;
      const evidence = {
        current: commerce.commerce.current,
        comparison: commerce.commerce.comparison,
        currency: commerce.currency,
        classificationCoverageCurrent: commerce.commerce.current.orders > 0 ? currentKnown / commerce.commerce.current.orders : 0,
        classificationCoverageComparison: commerce.commerce.comparison.orders > 0 ? comparisonKnown / commerce.commerce.comparison.orders : 0,
        observationStart: dayStart(commerce.window.current.from),
        observationEnd: dayEnd(commerce.window.current.to),
        comparisonStart: dayStart(commerce.window.comparison.from),
        comparisonEnd: dayEnd(commerce.window.comparison.to),
      };
      for (const result of [
        refundDeteriorationRule(evidence),
        discountDependencyRule(evidence),
        returningCustomerDeteriorationRule(evidence),
      ]) {
        if (result) extra.push(result);
      }
    }

    const mapping = mappingCoverageDegradedRule({
      mappingCoverage: snapshot.value.evidence.mappingCoverage,
      metaRows: snapshot.value.evidence.metaRows,
      observationStart: dayStart(snapshot.value.windows.product.from),
      observationEnd: dayEnd(snapshot.value.windows.product.to),
    });
    if (mapping) extra.push(mapping);

    return {
      ...snapshot.value,
      evidence: {
        ...snapshot.value.evidence,
        storefrontSessions,
        storefrontQuality,
        storefrontProductsEvaluated,
        landingPagesEvaluated,
      },
      recommendations: [
        ...snapshot.value.recommendations,
        ...extra.map((recommendation) => ({ ...recommendation, priority: priority(recommendation) })),
      ].sort((left, right) => right.priority - left.priority),
    };
  }
}

export const intelligenceSnapshotReadService = new IntelligenceSnapshotReadService();
