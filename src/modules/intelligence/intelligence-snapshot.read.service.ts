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
import { buildStorefrontEvidence } from './storefront-intelligence.evidence.js';
import {
  cartAbandonmentDeteriorationRule,
  checkoutAbandonmentDeteriorationRule,
  storefrontConversionDeteriorationRule,
} from './storefront-intelligence.rules.js';
import type { RecommendationDraft } from './intelligence.types.js';

const INTELLIGENCE_WINDOW_DAYS = 7;

function priority(recommendation: RecommendationDraft) {
  return recommendation.impactScore * recommendation.confidenceScore * recommendation.urgencyScore;
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
    const [snapshot, storefrontResult, commerceResult] = await Promise.allSettled([
      this.service.snapshot(storeId),
      pixelBehaviorService.overview(storeId, { days: INTELLIGENCE_WINDOW_DAYS }),
      analyticsWorkspace.overview(storeId, { days: INTELLIGENCE_WINDOW_DAYS }),
    ]);
    if (snapshot.status === 'rejected') throw snapshot.reason;

    const extra: RecommendationDraft[] = [];
    let storefrontSessions: number | null = null;
    let storefrontQuality: string | null = null;

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
        observationStart: commerce.window.current.instantFrom,
        observationEnd: commerce.window.current.instantTo,
        comparisonStart: commerce.window.comparison.instantFrom,
        comparisonEnd: commerce.window.comparison.instantTo,
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
      observationStart: new Date(`${snapshot.value.windows.product.from}T00:00:00.000Z`),
      observationEnd: new Date(`${snapshot.value.windows.product.to}T23:59:59.999Z`),
    });
    if (mapping) extra.push(mapping);

    return {
      ...snapshot.value,
      evidence: {
        ...snapshot.value.evidence,
        storefrontSessions,
        storefrontQuality,
      },
      recommendations: [
        ...snapshot.value.recommendations,
        ...extra.map((recommendation) => ({ ...recommendation, priority: priority(recommendation) })),
      ].sort((left, right) => right.priority - left.priority),
    };
  }
}

export const intelligenceSnapshotReadService = new IntelligenceSnapshotReadService();
