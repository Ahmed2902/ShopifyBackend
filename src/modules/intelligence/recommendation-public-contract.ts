import type {
  DataQualityEvidence,
  RecommendationDraft,
  RecommendationLimitation,
} from './intelligence.types.js';

const PUBLIC_BLOCKING_LIMITATIONS = new Set([
  'META_CONNECTION_BLOCKED',
  'META_ACCOUNTS_NOT_SELECTED',
  'META_INSIGHTS_MISSING',
  'META_SYNC_STALE',
  'SHOPIFY_CONNECTION_BLOCKED',
  'SHOPIFY_HISTORY_LIMITED',
  'SHOPIFY_SYNC_STALE',
  'PRODUCT_AD_MAPPING_LOW',
  'META_CURRENCY_MISMATCH',
  'PIXEL_NOT_ACTIVE',
  'PIXEL_BEHAVIOR_MISSING',
  'PIXEL_ROLLUP_ERROR',
  'PIXEL_EVENTS_STALE',
  'ACCOUNT_CURRENCY_MISSING',
  'CURRENT_PROVIDER_EVIDENCE_MISSING',
  'TARGET_UNRESOLVED',
  'TARGET_UNKNOWN',
  'AMBIGUOUS_MAPPING',
  'MAPPING_AMBIGUOUS',
]);

const PUBLIC_BLOCKING_QUALITY_CODES = new Set([
  'PROVIDER_CONNECTION_BLOCKED',
  'SELECTED_ACCOUNT_EVIDENCE_MISSING',
  'FAILED_SYNC',
  'PARTIAL_SYNC',
  'STALE_SYNC',
  'CURRENCY_MISMATCH',
]);

const COMPARISON_REQUIRED_RULES = new Set([
  'campaign_efficiency_deterioration',
  'adset_efficiency_deterioration',
  'ad_efficiency_deterioration',
  'creative_fatigue_symptoms',
  'video_retention_deterioration',
  'cart_abandonment_deterioration',
  'checkout_abandonment_deterioration',
  'view_to_cart_deterioration',
  'storefront_conversion_deterioration',
  'product_conversion_deterioration',
  'landing_page_quality_deterioration',
  'refund_rate_deterioration',
  'discount_dependency_deterioration',
  'returning_customer_deterioration',
]);

const UNIFIED_COMPARISON_SIGNAL_MARKERS = [
  'spend_up_efficiency_down',
  'cpc_deterioration',
  'ctr_deterioration',
  'conversions_down_spend_up',
  'strong_provider_efficiency',
  'sudden_delivery_change',
];

export type RecommendationThresholdCondition = {
  metric: string;
  operator: '>=' | '<=' | '>' | '<' | '=';
  value: number | string;
  unit?: 'COUNT' | 'RATIO' | 'PERCENT_CHANGE' | 'PERCENTAGE_POINTS' | 'CURRENCY' | 'DAYS';
};

export type RecommendationThreshold = {
  description: string;
  conditions: RecommendationThresholdCondition[];
};

type PublicQualityItem = Pick<DataQualityEvidence, 'code' | 'status' | 'surface'> & {
  provider?: string;
  accountId?: string;
};

function threshold(
  description: string,
  conditions: RecommendationThresholdCondition[],
): RecommendationThreshold {
  return { description, conditions };
}

function unifiedSignalThreshold(ruleId: string): RecommendationThreshold | null {
  if (ruleId.endsWith('_no_conversion_spend')) {
    return threshold('Current provider spend is positive while provider-reported conversions are exactly zero.', [
      { metric: 'current.spend', operator: '>', value: 0, unit: 'CURRENCY' },
      { metric: 'current.providerConversions', operator: '=', value: 0, unit: 'COUNT' },
      { metric: 'current.impressions', operator: '>=', value: 100, unit: 'COUNT' },
    ]);
  }
  if (ruleId.endsWith('_spend_up_efficiency_down')) {
    return threshold('Spend increased by at least 15% while provider-reported ROAS fell by at least 15%.', [
      { metric: 'change.spend', operator: '>=', value: 0.15, unit: 'PERCENT_CHANGE' },
      { metric: 'change.providerRoas', operator: '<=', value: -0.15, unit: 'PERCENT_CHANGE' },
      { metric: 'current.impressions', operator: '>=', value: 100, unit: 'COUNT' },
      { metric: 'comparison.impressions', operator: '>=', value: 100, unit: 'COUNT' },
    ]);
  }
  if (ruleId.endsWith('_cpc_deterioration')) {
    return threshold('Cost per click increased by at least 20% versus the comparison period.', [
      { metric: 'change.cpc', operator: '>=', value: 0.2, unit: 'PERCENT_CHANGE' },
      { metric: 'current.impressions', operator: '>=', value: 100, unit: 'COUNT' },
      { metric: 'comparison.impressions', operator: '>=', value: 100, unit: 'COUNT' },
    ]);
  }
  if (ruleId.endsWith('_ctr_deterioration')) {
    return threshold('Click-through rate fell by at least 20% versus the comparison period.', [
      { metric: 'change.ctr', operator: '<=', value: -0.2, unit: 'PERCENT_CHANGE' },
      { metric: 'current.impressions', operator: '>=', value: 100, unit: 'COUNT' },
      { metric: 'comparison.impressions', operator: '>=', value: 100, unit: 'COUNT' },
    ]);
  }
  if (ruleId.endsWith('_conversions_down_spend_up')) {
    return threshold('Spend increased by more than 10% while provider-reported conversions fell by more than 10%.', [
      { metric: 'change.spend', operator: '>', value: 0.1, unit: 'PERCENT_CHANGE' },
      { metric: 'change.providerConversions', operator: '<', value: -0.1, unit: 'PERCENT_CHANGE' },
      { metric: 'current.impressions', operator: '>=', value: 100, unit: 'COUNT' },
      { metric: 'comparison.impressions', operator: '>=', value: 100, unit: 'COUNT' },
    ]);
  }
  if (ruleId.endsWith('_strong_provider_efficiency')) {
    return threshold('Provider-reported ROAS improved by at least 15% with at least 5 conversions and 1,000 impressions in both periods.', [
      { metric: 'current.providerRoas / comparison.providerRoas', operator: '>=', value: 1.15, unit: 'RATIO' },
      { metric: 'current.providerConversions', operator: '>=', value: 5, unit: 'COUNT' },
      { metric: 'current.impressions', operator: '>=', value: 1000, unit: 'COUNT' },
      { metric: 'comparison.impressions', operator: '>=', value: 1000, unit: 'COUNT' },
    ]);
  }
  if (ruleId.endsWith('_sudden_delivery_change')) {
    return threshold('Absolute spend change is at least 50% versus the comparison period.', [
      { metric: 'abs(change.spend)', operator: '>=', value: 0.5, unit: 'PERCENT_CHANGE' },
      { metric: 'current.impressions', operator: '>=', value: 100, unit: 'COUNT' },
      { metric: 'comparison.impressions', operator: '>=', value: 100, unit: 'COUNT' },
    ]);
  }
  return null;
}

export function recommendationThreshold(ruleId: string): RecommendationThreshold | null {
  const unified = unifiedSignalThreshold(ruleId);
  if (unified) return unified;

  switch (ruleId) {
    case 'campaign_efficiency_deterioration':
      return threshold('Spend increased at least 15% while ROAS fell at least 20% or CPA rose at least 20%, with at least 1,000 impressions in both periods.', [
        { metric: 'change.spend', operator: '>=', value: 0.15, unit: 'PERCENT_CHANGE' },
        { metric: 'current.impressions', operator: '>=', value: 1000, unit: 'COUNT' },
        { metric: 'comparison.impressions', operator: '>=', value: 1000, unit: 'COUNT' },
      ]);
    case 'adset_efficiency_deterioration':
    case 'ad_efficiency_deterioration':
      return threshold('Current and comparison spend are each at least 50, spend increased at least 15%, and provider-reported ROAS fell at least 20% or CPA rose at least 20%.', [
        { metric: 'current.spend', operator: '>=', value: 50, unit: 'CURRENCY' },
        { metric: 'comparison.spend', operator: '>=', value: 50, unit: 'CURRENCY' },
        { metric: 'change.spend', operator: '>=', value: 0.15, unit: 'PERCENT_CHANGE' },
      ]);
    case 'creative_fatigue_symptoms':
      return threshold('Frequency rose at least 20%, CTR fell at least 20%, and CPA rose at least 15% or ROAS fell at least 20%, with at least 1,000 impressions in both periods.', [
        { metric: 'change.frequency', operator: '>=', value: 0.2, unit: 'PERCENT_CHANGE' },
        { metric: 'change.ctr', operator: '<=', value: -0.2, unit: 'PERCENT_CHANGE' },
        { metric: 'current.impressions', operator: '>=', value: 1000, unit: 'COUNT' },
        { metric: 'comparison.impressions', operator: '>=', value: 1000, unit: 'COUNT' },
      ]);
    case 'video_retention_deterioration':
      return threshold('Meta video evidence is READY, both periods meet the diagnostic minimum-play requirement, and either 25% view-through rate or completion rate fell by at least 10 percentage points.', [
        { metric: 'change.to25Rate', operator: '<=', value: -0.1, unit: 'PERCENTAGE_POINTS' },
        { metric: 'change.completionRate', operator: '<=', value: -0.1, unit: 'PERCENTAGE_POINTS' },
      ]);
    case 'underexposed_commerce_winner':
      return threshold('At least 5 units, at least 8% Shopify revenue share, exact mapping confidence at least 70%, and mapped spend share below 60% of revenue share.', [
        { metric: 'units', operator: '>=', value: 5, unit: 'COUNT' },
        { metric: 'revenueShare', operator: '>=', value: 0.08, unit: 'RATIO' },
        { metric: 'mappingConfidence', operator: '>=', value: 0.7, unit: 'RATIO' },
      ]);
    case 'paid_commerce_exposure_mismatch':
      return threshold('Mapped spend share is at least 8% and materially exceeds Shopify revenue share, with exact mapping confidence at least 70% and minimum commerce or impression support.', [
        { metric: 'mappedSpendShare', operator: '>=', value: 0.08, unit: 'RATIO' },
        { metric: 'mappingConfidence', operator: '>=', value: 0.7, unit: 'RATIO' },
      ]);
    case 'provider_roas_margin_trap':
      return threshold('Provider-reported ROAS is at least 1.5 while Shopify contribution after mapped ads is at or below zero and cost coverage is at least 80%.', [
        { metric: 'providerRoas', operator: '>=', value: 1.5, unit: 'RATIO' },
        { metric: 'contributionAfterAds', operator: '<=', value: 0, unit: 'CURRENCY' },
        { metric: 'costCoverage', operator: '>=', value: 0.8, unit: 'RATIO' },
      ]);
    case 'inventory_spend_conflict':
    case 'shared_exposure_inventory_conflict':
      return threshold('Trusted inventory is at or below the merchant-configured reorder point while mapped/shared paid spend remains active.', [
        { metric: 'stockAvailable', operator: '<=', value: 'reorderPoint', unit: 'COUNT' },
        { metric: 'mapped/shared paid spend', operator: '>', value: 0, unit: 'CURRENCY' },
      ]);
    case 'inventory_runway_risk':
      return threshold('Trusted inventory is at or below the merchant-configured reorder point with positive observed sales velocity and no mapped paid-spend pressure.', [
        { metric: 'stockAvailable', operator: '<=', value: 'reorderPoint', unit: 'COUNT' },
        { metric: 'recentUnitsPerDay', operator: '>', value: 0, unit: 'COUNT' },
        { metric: 'mappedMetaSpend', operator: '=', value: 0, unit: 'CURRENCY' },
      ]);
    case 'cart_abandonment_deterioration':
      return threshold('Cart abandonment is at least 45% and increased by at least 10 percentage points, with at least 30 cart-view sessions in both periods.', [
        { metric: 'current.cartAbandonmentRate', operator: '>=', value: 0.45, unit: 'RATIO' },
        { metric: 'change.cartAbandonmentRate', operator: '>=', value: 0.1, unit: 'PERCENTAGE_POINTS' },
      ]);
    case 'checkout_abandonment_deterioration':
      return threshold('Checkout abandonment is at least 30% and increased by at least 8 percentage points, with at least 25 checkout starts in both periods.', [
        { metric: 'current.checkoutAbandonmentRate', operator: '>=', value: 0.3, unit: 'RATIO' },
        { metric: 'change.checkoutAbandonmentRate', operator: '>=', value: 0.08, unit: 'PERCENTAGE_POINTS' },
      ]);
    case 'view_to_cart_deterioration':
      return threshold('View-to-cart rate fell by at least 4 percentage points and at least 25% relatively, with at least 75 product-view sessions in both periods.', [
        { metric: 'change.viewToCartRate', operator: '<=', value: -0.04, unit: 'PERCENTAGE_POINTS' },
        { metric: 'relativeChange.viewToCartRate', operator: '<=', value: -0.25, unit: 'PERCENT_CHANGE' },
      ]);
    case 'storefront_conversion_deterioration':
      return threshold('Linked-purchase rate fell by at least 1 percentage point and at least 20% relatively, with at least 150 sessions in both periods.', [
        { metric: 'change.linkedPurchaseRate', operator: '<=', value: -0.01, unit: 'PERCENTAGE_POINTS' },
        { metric: 'relativeChange.linkedPurchaseRate', operator: '<=', value: -0.2, unit: 'PERCENT_CHANGE' },
      ]);
    case 'product_conversion_deterioration':
      return threshold('Product linked-purchase rate fell by at least 1.5 percentage points and at least 30% relatively, with at least 40 product-view sessions in both periods.', [
        { metric: 'change.linkedPurchaseRate', operator: '<=', value: -0.015, unit: 'PERCENTAGE_POINTS' },
        { metric: 'relativeChange.linkedPurchaseRate', operator: '<=', value: -0.3, unit: 'PERCENT_CHANGE' },
      ]);
    case 'high_traffic_low_conversion_product':
      return threshold('At least 150 observed product-view sessions with linked Shopify purchase rate at or below 1.5%.', [
        { metric: 'productViewSessions', operator: '>=', value: 150, unit: 'COUNT' },
        { metric: 'linkedPurchaseRate', operator: '<=', value: 0.015, unit: 'RATIO' },
      ]);
    case 'landing_page_quality_deterioration':
      return threshold('Landing-page linked-purchase rate fell by at least 1.5 percentage points and at least 30% relatively, with at least 75 sessions in both periods.', [
        { metric: 'change.linkedPurchaseRate', operator: '<=', value: -0.015, unit: 'PERCENTAGE_POINTS' },
        { metric: 'relativeChange.linkedPurchaseRate', operator: '<=', value: -0.3, unit: 'PERCENT_CHANGE' },
      ]);
    case 'refund_rate_deterioration':
      return threshold('Refund rate is at least 5% and increased by at least 4 percentage points, with at least 20 Shopify orders in both periods.', [
        { metric: 'current.refundRate', operator: '>=', value: 0.05, unit: 'RATIO' },
        { metric: 'change.refundRate', operator: '>=', value: 0.04, unit: 'PERCENTAGE_POINTS' },
      ]);
    case 'discount_dependency_deterioration':
      return threshold('Discount rate is at least 10% and increased by at least 5 percentage points, with at least 20 Shopify orders in both periods.', [
        { metric: 'current.discountRate', operator: '>=', value: 0.1, unit: 'RATIO' },
        { metric: 'change.discountRate', operator: '>=', value: 0.05, unit: 'PERCENTAGE_POINTS' },
      ]);
    case 'returning_customer_deterioration':
      return threshold('Returning-order share fell by at least 10 percentage points with at least 80% classified-customer coverage and 20 classified orders in both periods.', [
        { metric: 'change.returningOrderShare', operator: '<=', value: -0.1, unit: 'PERCENTAGE_POINTS' },
        { metric: 'current.knownCustomerCoverage', operator: '>=', value: 0.8, unit: 'RATIO' },
        { metric: 'comparison.knownCustomerCoverage', operator: '>=', value: 0.8, unit: 'RATIO' },
      ]);
    case 'mapping_coverage_degraded':
      return threshold('Current mapped Meta spend is positive while exact product mapping coverage is below 60%.', [
        { metric: 'totalMetaSpend', operator: '>', value: 0, unit: 'CURRENCY' },
        { metric: 'mappingCoverage', operator: '<', value: 0.6, unit: 'RATIO' },
      ]);
    case 'provider_first_party_purchase_gap':
      return threshold('Attribution evidence is READY, provider-reported purchases are at least 20, first-party Meta-touched Shopify purchase journeys are at least 10, Meta-touched sessions are at least 100, and the absolute purchase-count gap is at least 30% of the larger count.', [
        { metric: 'providerPurchases', operator: '>=', value: 20, unit: 'COUNT' },
        { metric: 'firstPartyMetaPurchaseJourneys', operator: '>=', value: 10, unit: 'COUNT' },
        { metric: 'metaTouchedSessions', operator: '>=', value: 100, unit: 'COUNT' },
        { metric: 'relativeGap', operator: '>=', value: 0.3, unit: 'RATIO' },
      ]);
    case 'unified_inventory_paid_spend_conflict':
      return threshold('Exact mapped paid spend is positive while trusted inventory is SOLD_OUT, STOCKOUT_RISK, or LOW_STOCK.', [
        { metric: 'mappedPaidSpend', operator: '>', value: 0, unit: 'CURRENCY' },
      ]);
    case 'unified_inventory_overstock_weak_demand':
      return threshold('Authoritative Shopify sales velocity is exactly zero while trusted available inventory is more than three times the merchant low-stock threshold.', [
        { metric: 'unitsPerDay', operator: '=', value: 0, unit: 'COUNT' },
      ]);
    case 'unified_product_paid_demand_negative_contribution':
      return threshold('Authoritative Shopify contribution after exact mapped paid spend is below zero.', [
        { metric: 'contributionAfterAds', operator: '<', value: 0, unit: 'CURRENCY' },
      ]);
    case 'unified_profitable_product_low_paid_support':
      return threshold('Authoritative Shopify revenue and contribution are positive, trusted inventory is healthy, and exact mapped paid spend is genuinely zero.', [
        { metric: 'mappedPaidSpend', operator: '=', value: 0, unit: 'CURRENCY' },
        { metric: 'netProductRevenue', operator: '>', value: 0, unit: 'CURRENCY' },
        { metric: 'contributionBeforeAds', operator: '>', value: 0, unit: 'CURRENCY' },
      ]);
    case 'unified_paid_product_weak_view_to_cart':
      return threshold('Exact mapped paid spend is positive, at least 20 first-party product-view sessions were observed, and view-to-cart rate is below 10%.', [
        { metric: 'mappedPaidSpend', operator: '>', value: 0, unit: 'CURRENCY' },
        { metric: 'productViewSessions', operator: '>=', value: 20, unit: 'COUNT' },
        { metric: 'viewToCartRate', operator: '<', value: 0.1, unit: 'RATIO' },
      ]);
    default:
      return null;
  }
}

function limitationBlocksPublicRecommendation(limitation: RecommendationLimitation): boolean {
  if (PUBLIC_BLOCKING_LIMITATIONS.has(limitation.code)) return true;
  const upper = limitation.code.toUpperCase();
  return upper.includes('AMBIGUOUS') || upper.includes('UNRESOLVED');
}

function comparisonEvidenceMissing(recommendation: RecommendationDraft) {
  return recommendation.limitations.some((limitation) =>
    ['COMPARISON_PROVIDER_EVIDENCE_MISSING', 'COMPARISON_DELIVERY_INSUFFICIENT'].includes(
      limitation.code,
    ),
  );
}

function ruleNeedsComparison(ruleId: string) {
  if (COMPARISON_REQUIRED_RULES.has(ruleId)) return true;
  return UNIFIED_COMPARISON_SIGNAL_MARKERS.some((marker) => ruleId.endsWith(`_${marker}`));
}

function recommendationProvider(recommendation: RecommendationDraft): string | null {
  const provider = recommendation.evidence.provider;
  return typeof provider === 'string' ? provider : null;
}

function recommendationAccountId(recommendation: RecommendationDraft): string | null {
  const accountId = recommendation.evidence.accountId;
  return typeof accountId === 'string' ? accountId : null;
}

function relevantQualityBlocker(
  recommendation: RecommendationDraft,
  item: PublicQualityItem,
): boolean {
  if (!PUBLIC_BLOCKING_QUALITY_CODES.has(item.code)) return false;
  const provider = recommendationProvider(recommendation);
  const accountId = recommendationAccountId(recommendation);
  if (item.provider && provider && item.provider !== provider) return false;
  if (item.accountId && accountId && item.accountId !== accountId) return false;
  if (
    recommendation.attributionPrecision === 'SHOPIFY_COMMERCE' ||
    recommendation.attributionPrecision === 'FIRST_PARTY_OBSERVED'
  ) {
    return item.code === 'CURRENCY_MISMATCH';
  }
  return true;
}

export function recommendationHasRequiredEvidence(
  recommendation: RecommendationDraft,
  dataQuality: readonly PublicQualityItem[] = [],
): boolean {
  if (recommendation.ruleId.startsWith('unified_data_quality_')) return false;
  if (recommendation.ruleId.includes('insufficient_current_evidence')) return false;
  if (recommendation.limitations.some(limitationBlocksPublicRecommendation)) return false;
  if (ruleNeedsComparison(recommendation.ruleId) && comparisonEvidenceMissing(recommendation)) {
    return false;
  }
  return !dataQuality.some((item) => relevantQualityBlocker(recommendation, item));
}

export function publicRecommendation(
  recommendation: RecommendationDraft & {
    priority: number;
    decisionAction: string;
    decisionConfidence?: unknown;
    decisionBasis: 'DETERMINISTIC_RULE';
    decisionMessage: string;
    occurrenceKey: string;
    lifecycleState: string;
    lifecycleUpdatedAt: Date | null;
    entityName?: string | null;
  },
) {
  const {
    confidenceScore: _confidenceScore,
    evidenceQuality: _evidenceQuality,
    decisionConfidence: _decisionConfidence,
    ...rest
  } = recommendation;
  return {
    ...rest,
    finding: recommendation.summary,
    affectedEntity: {
      type: recommendation.entityType,
      id: recommendation.entityId,
      externalId: recommendation.externalEntityId,
      name: recommendation.entityName ?? null,
    },
    measuredValues: recommendation.evidence,
    comparisonPeriod: {
      current: {
        from: recommendation.observationStart,
        to: recommendation.observationEnd,
      },
      comparison:
        recommendation.comparisonStart && recommendation.comparisonEnd
          ? { from: recommendation.comparisonStart, to: recommendation.comparisonEnd }
          : null,
    },
    thresholdCrossed: recommendationThreshold(recommendation.ruleId),
  };
}
