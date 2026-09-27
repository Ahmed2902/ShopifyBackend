import type {
  DataQualityEvidence,
  RecommendationDraft,
} from './intelligence.types.js';

export interface RecommendationThresholdCrossed {
  description: string;
  conditions: string[];
}

type RecommendationWithPriority = RecommendationDraft & { priority?: number };

const RULE_THRESHOLDS: Record<string, RecommendationThresholdCrossed> = {
  campaign_efficiency_deterioration: {
    description: 'Spend expanded while provider-reported efficiency deteriorated with sufficient delivery in both periods.',
    conditions: [
      'current impressions >= 1,000',
      'comparison impressions >= 1,000',
      'current spend > 0 and comparison spend > 0',
      'spend change >= +15%',
      'ROAS change <= -20% OR CPA change >= +20%',
    ],
  },
  adset_efficiency_deterioration: {
    description: 'Spend expanded while provider-reported efficiency deteriorated with sufficient delivery in both periods.',
    conditions: [
      'current impressions >= 1,000',
      'comparison impressions >= 1,000',
      'current spend > 0 and comparison spend > 0',
      'spend change >= +15%',
      'ROAS change <= -20% OR CPA change >= +20%',
    ],
  },
  ad_efficiency_deterioration: {
    description: 'Spend expanded while provider-reported efficiency deteriorated with sufficient delivery in both periods.',
    conditions: [
      'current impressions >= 1,000',
      'comparison impressions >= 1,000',
      'current spend > 0 and comparison spend > 0',
      'spend change >= +15%',
      'ROAS change <= -20% OR CPA change >= +20%',
    ],
  },
  creative_fatigue_symptoms: {
    description: 'Repeat exposure rose while engagement and provider-reported efficiency both deteriorated.',
    conditions: [
      'current impressions >= 1,000',
      'comparison impressions >= 1,000',
      'frequency change >= +20%',
      'CTR change <= -20%',
      'CPA change >= +15% OR ROAS change <= -20%',
    ],
  },
  video_retention_deterioration: {
    description: 'Observed video retention deteriorated beyond the rule threshold with sufficient comparable delivery.',
    conditions: ['the video-retention rule sample minimum is met', 'the configured retention deterioration threshold is crossed'],
  },
  underexposed_commerce_winner: {
    description: 'Shopify commerce share materially exceeds exactly mapped paid-spend share.',
    conditions: [
      'Shopify units >= 5',
      'exact product mapping confidence >= 0.70',
      'Shopify revenue share >= 8%',
      'mapped paid-spend share < 60% of revenue share',
    ],
  },
  paid_commerce_exposure_mismatch: {
    description: 'Exactly mapped paid-spend share materially exceeds the product’s Shopify revenue share.',
    conditions: [
      'Shopify units >= 2 OR mapped impressions >= 1,000',
      'exact product mapping confidence >= 0.70',
      'mapped paid-spend share >= 8%',
      'Shopify revenue share <= 55% of mapped paid-spend share',
    ],
  },
  provider_roas_margin_trap: {
    description: 'Provider-reported ROAS is positive while complete Shopify product economics show non-positive contribution after exactly mapped ads.',
    conditions: ['cost coverage >= 80%', 'provider-reported ROAS >= 1.5', 'contribution after ads <= 0'],
  },
  inventory_spend_conflict: {
    description: 'Trusted inventory is at or below the merchant-configured reorder point while exactly mapped paid spend remains active.',
    conditions: ['inventory is trusted', 'mapped paid spend > 0', 'stock available <= calculated reorder point'],
  },
  shared_exposure_inventory_conflict: {
    description: 'A shared paid-media exposure includes at least one product at or below its merchant-configured reorder point.',
    conditions: [
      'inventory is trusted',
      'shared ad spend > 0',
      'impressions >= 1,000',
      'shared scope is merchant-confirmed OR scope confidence >= 0.70',
      'at least one affected product is at or below its reorder point',
    ],
  },
  inventory_runway_risk: {
    description: 'Trusted Shopify stock is at or below the merchant-configured reorder point without mapped paid-spend pressure.',
    conditions: [
      'inventory is trusted and stock is known',
      'recent observed unit velocity > 0',
      'Shopify units >= 3 OR revenue share >= 3%',
      'mapped paid spend = 0',
      'stock available <= calculated reorder point',
    ],
  },
  cart_abandonment_deterioration: {
    description: 'Observed cart abandonment is both high and materially worse than the comparison period.',
    conditions: ['cart-view sessions >= 30 in both periods', 'current cart abandonment >= 45%', 'increase >= 10 percentage points'],
  },
  checkout_abandonment_deterioration: {
    description: 'Observed checkout abandonment is both high and materially worse than the comparison period.',
    conditions: ['checkout-start sessions >= 25 in both periods', 'current checkout abandonment >= 30%', 'increase >= 8 percentage points'],
  },
  view_to_cart_deterioration: {
    description: 'Observed view-to-cart progression deteriorated materially versus the comparison period.',
    conditions: ['product-view sessions >= 75 in both periods', 'rate decrease >= 4 percentage points', 'relative decrease >= 25%'],
  },
  storefront_conversion_deterioration: {
    description: 'Observed linked-purchase conversion deteriorated materially versus the comparison period.',
    conditions: ['sessions >= 150 in both periods', 'rate decrease >= 1 percentage point', 'relative decrease >= 20%'],
  },
  product_conversion_deterioration: {
    description: 'Observed product linked-purchase conversion deteriorated materially versus its comparison period.',
    conditions: ['product-view sessions >= 40 in both periods', 'rate decrease >= 1.5 percentage points', 'relative decrease >= 30%'],
  },
  high_traffic_low_conversion_product: {
    description: 'A product has substantial observed product-view traffic and a very low linked-purchase rate.',
    conditions: ['current product-view sessions >= 150', 'current linked-purchase rate <= 1.5%'],
  },
  landing_page_quality_deterioration: {
    description: 'A landing route’s observed linked-purchase conversion deteriorated materially versus its comparison period.',
    conditions: ['sessions >= 75 in both periods', 'rate decrease >= 1.5 percentage points', 'relative decrease >= 30%'],
  },
  refund_rate_deterioration: {
    description: 'Shopify refund pressure is materially higher than the comparison period.',
    conditions: ['orders >= 20 in both periods', 'current refund rate >= 5%', 'increase >= 4 percentage points', 'relative increase >= 40% when comparison refund rate is non-zero'],
  },
  discount_dependency_deterioration: {
    description: 'Discount value represents a materially larger share of Shopify order value.',
    conditions: ['orders >= 20 in both periods', 'current discount rate >= 10%', 'increase >= 5 percentage points'],
  },
  returning_customer_deterioration: {
    description: 'Returning-order share fell materially with sufficient classified-order coverage.',
    conditions: ['known-customer coverage >= 80% in both periods', 'classified orders >= 20 in both periods', 'returning-order share decrease >= 10 percentage points'],
  },
  mapping_coverage_degraded: {
    description: 'A material share of same-currency paid spend cannot be exactly mapped to products.',
    conditions: ['total paid spend > 0', 'exact product mapping coverage < 60%'],
  },
  provider_first_party_purchase_gap: {
    description: 'Provider-reported purchases and first-party Meta-touched Shopify purchase journeys differ materially.',
    conditions: ['attribution quality is READY', 'provider purchases >= 20', 'first-party Meta purchase journeys >= 10', 'Meta-touched sessions >= 100', 'relative purchase-count gap >= 30%'],
  },
  unified_inventory_paid_spend_conflict: {
    description: 'Exactly mapped paid spend is active while trusted inventory is sold out, low, or at stockout risk.',
    conditions: ['mapped paid spend > 0', 'inventory state is SOLD_OUT, STOCKOUT_RISK, or LOW_STOCK'],
  },
  unified_inventory_overstock_weak_demand: {
    description: 'Trusted inventory is elevated while authoritative Shopify sales velocity is exactly zero.',
    conditions: ['authoritative Shopify commerce evidence is available', 'inventory state is OVERSTOCK_WEAK_DEMAND'],
  },
  unified_product_paid_demand_negative_contribution: {
    description: 'Complete Shopify product economics minus exactly mapped paid spend produce negative contribution after ads.',
    conditions: ['authoritative Shopify commerce evidence is available', 'inefficient paid demand = true'],
  },
  unified_profitable_product_low_paid_support: {
    description: 'A profitable Shopify product with healthy trusted inventory has a genuine zero of exactly mapped paid spend.',
    conditions: ['authoritative Shopify commerce evidence is available', 'mapped paid spend = 0', 'net product revenue > 0', 'contribution before ads > 0', 'inventory state is HEALTHY'],
  },
  unified_paid_product_weak_view_to_cart: {
    description: 'Exactly mapped paid spend is active while first-party product views progress to cart below the deterministic threshold.',
    conditions: ['mapped paid spend > 0', 'Stride Pixel product evidence is available and fresh', 'product-view sessions >= 20', 'view-to-cart rate < 10%'],
  },
};

const UNIFIED_SIGNAL_THRESHOLDS: Record<string, RecommendationThresholdCrossed> = {
  no_conversion_spend: {
    description: 'Provider-reported spend is positive while complete provider conversion evidence reports a genuine zero.',
    conditions: ['current impressions >= 100', 'current spend > 0', 'complete provider-reported conversions = 0'],
  },
  spend_up_efficiency_down: {
    description: 'Provider spend increased while provider-reported ROAS deteriorated.',
    conditions: ['current and comparison impressions >= 100', 'spend change >= +15%', 'provider ROAS change <= -15%'],
  },
  cpc_deterioration: {
    description: 'Provider cost per click increased materially versus the comparison period.',
    conditions: ['current and comparison impressions >= 100', 'CPC change >= +20%'],
  },
  ctr_deterioration: {
    description: 'Provider click-through rate decreased materially versus the comparison period.',
    conditions: ['current and comparison impressions >= 100', 'CTR change <= -20%'],
  },
  conversions_down_spend_up: {
    description: 'Provider-reported conversions decreased while spend increased.',
    conditions: ['current and comparison impressions >= 100', 'spend change > +10%', 'provider-reported conversions change < -10%'],
  },
  strong_provider_efficiency: {
    description: 'Provider-reported ROAS improved with a non-trivial complete conversion and delivery sample.',
    conditions: ['current and comparison impressions >= 1,000', 'complete current provider conversions >= 5', 'current provider ROAS >= 115% of comparison ROAS'],
  },
  sudden_delivery_change: {
    description: 'Provider spend changed sharply versus the comparison period.',
    conditions: ['current and comparison impressions >= 100', 'absolute spend change >= 50%'],
  },
};

function publicText(value: string): string {
  return value.replace(/high-confidence mapped/gi, 'exactly mapped');
}

export function recommendationThresholdCrossed(ruleId: string): RecommendationThresholdCrossed {
  const exact = RULE_THRESHOLDS[ruleId];
  if (exact) return exact;
  if (ruleId.startsWith('unified_')) {
    for (const [suffix, threshold] of Object.entries(UNIFIED_SIGNAL_THRESHOLDS)) {
      if (ruleId.endsWith(`_${suffix}`)) return threshold;
    }
  }
  return {
    description: 'The deterministic rule conditions encoded by this rule version were satisfied.',
    conditions: [`rule ${ruleId} emitted only after its required inputs and threshold checks passed`],
  };
}

export function presentRecommendation<T extends RecommendationWithPriority>(recommendation: T) {
  const {
    confidenceScore: _confidenceScore,
    evidenceQuality: _evidenceQuality,
    ...publicRecommendation
  } = recommendation;
  const title = publicText(recommendation.title);
  const summary = publicText(recommendation.summary);
  return {
    ...publicRecommendation,
    title,
    summary,
    finding: { title, summary },
    affectedEntity: {
      type: recommendation.entityType,
      id: recommendation.entityId,
      externalId: recommendation.externalEntityId,
      name: recommendation.entityName ?? null,
    },
    measuredValues: recommendation.evidence,
    comparisonPeriod: {
      current: { from: recommendation.observationStart, to: recommendation.observationEnd },
      comparison:
        recommendation.comparisonStart && recommendation.comparisonEnd
          ? { from: recommendation.comparisonStart, to: recommendation.comparisonEnd }
          : null,
    },
    thresholdCrossed: recommendationThresholdCrossed(recommendation.ruleId),
  };
}

const META_BLOCKERS = new Set([
  'META_CONNECTION_BLOCKED',
  'META_ACCOUNTS_NOT_SELECTED',
  'META_INSIGHTS_MISSING',
  'META_SYNC_STALE',
]);
const SHOPIFY_BLOCKERS = new Set([
  'SHOPIFY_CONNECTION_BLOCKED',
  'SHOPIFY_HISTORY_LIMITED',
  'SHOPIFY_SYNC_STALE',
]);
const PIXEL_BLOCKERS = new Set([
  'PIXEL_NOT_ACTIVE',
  'PIXEL_BEHAVIOR_MISSING',
  'PIXEL_ROLLUP_ERROR',
  'PIXEL_EVENTS_STALE',
]);

export function recommendationInputsComplete(
  recommendation: RecommendationDraft,
  dataQuality: DataQualityEvidence[],
): boolean {
  const activeCodes = new Set(
    dataQuality.filter((item) => item.status !== 'HEALTHY').map((item) => item.code),
  );
  const hasAny = (codes: Set<string>) => [...codes].some((code) => activeCodes.has(code));

  if (recommendation.attributionPrecision === 'META_PROVIDER' && hasAny(META_BLOCKERS)) return false;

  const usesShopify = recommendation.attributionPrecision !== 'META_PROVIDER';
  if (usesShopify && hasAny(SHOPIFY_BLOCKERS)) return false;

  if (recommendation.attributionPrecision === 'EXACT_PRODUCT') {
    if (activeCodes.has('META_CURRENCY_MISMATCH')) return false;
    const mappingConfidence = recommendation.evidence.mappingConfidence;
    if (typeof mappingConfidence === 'number' && mappingConfidence < 0.7) return false;
    if (
      ['underexposed_commerce_winner', 'paid_commerce_exposure_mismatch'].includes(
        recommendation.ruleId,
      ) && activeCodes.has('PRODUCT_AD_MAPPING_LOW')
    ) {
      return false;
    }
  }

  if (recommendation.attributionPrecision === 'FIRST_PARTY_OBSERVED' && hasAny(PIXEL_BLOCKERS)) {
    return false;
  }

  if (
    recommendation.ruleId === 'provider_first_party_purchase_gap' &&
    (hasAny(META_BLOCKERS) || hasAny(PIXEL_BLOCKERS))
  ) {
    return false;
  }

  return true;
}
