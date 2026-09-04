import type {
  CampaignEvidence,
  CreativeEvidence,
  ProductEvidence,
  RecommendationAttributionPrecision,
  RecommendationDraft,
  RecommendationLimitation,
  SharedExposureEvidence,
} from './intelligence.types.js';

const RULE_VERSION = '2';
const MIN_PERIOD_IMPRESSIONS = 1_000;
const MIN_PRODUCT_MAPPING_CONFIDENCE = 0.7;
const LOW_GLOBAL_MAPPING_COVERAGE = 0.6;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function change(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / Math.abs(previous);
}

function round(value: number | null, digits = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function priorityParts(impact: number, confidence: number, urgency: number) {
  return {
    impactScore: clamp01(impact),
    confidenceScore: clamp01(confidence),
    urgencyScore: clamp01(urgency),
  };
}

function recommendationContext(input: {
  baseConfidence: number;
  attributionPrecision: RecommendationAttributionPrecision;
  limitations?: RecommendationLimitation[];
}) {
  const limitations = input.limitations ?? [];
  const severe = limitations.some((limitation) =>
    ['TARGET_UNRESOLVED', 'TARGET_UNKNOWN', 'MAPPING_COVERAGE_VERY_LOW'].includes(limitation.code),
  );
  const warningPenalty = limitations.length === 0 ? 1 : severe ? 0.75 : 0.88;
  const confidenceScore = clamp01(input.baseConfidence * warningPenalty);
  const evidenceQuality =
    !severe && confidenceScore >= 0.82
      ? ('HIGH' as const)
      : confidenceScore >= 0.58
        ? ('MEDIUM' as const)
        : ('LOW' as const);

  return {
    confidenceScore,
    evidenceQuality,
    attributionPrecision: input.attributionPrecision,
    limitations,
  };
}

function productLimitations(evidence: ProductEvidence): RecommendationLimitation[] {
  if (evidence.mappingCoverage >= LOW_GLOBAL_MAPPING_COVERAGE) return [];
  const veryLow = evidence.mappingCoverage < 0.3;
  return [
    {
      code: veryLow ? 'MAPPING_COVERAGE_VERY_LOW' : 'MAPPING_COVERAGE_PARTIAL',
      message: veryLow
        ? 'Less than 30% of same-currency Meta spend is exactly mapped. This recommendation uses the product evidence that is mapped, but account-wide comparisons are materially incomplete.'
        : 'Less than 60% of same-currency Meta spend is exactly mapped. This recommendation uses the product evidence that is mapped, but account-wide comparisons are incomplete.',
    },
  ];
}

function productCoverageConfidenceFactor(mappingCoverage: number): number {
  if (mappingCoverage >= LOW_GLOBAL_MAPPING_COVERAGE) return 1;
  return 0.7 + 0.3 * clamp01(mappingCoverage / LOW_GLOBAL_MAPPING_COVERAGE);
}

function windowFields(evidence: CampaignEvidence | CreativeEvidence) {
  const days = Math.max(
    1,
    Math.round((evidence.end.getTime() - evidence.start.getTime()) / 86_400_000) + 1,
  );
  return {
    observationStart: evidence.start,
    observationEnd: evidence.end,
    comparisonStart: new Date(evidence.start.getTime() - days * 86_400_000),
    comparisonEnd: new Date(evidence.start.getTime() - 86_400_000),
  };
}

export function campaignEfficiencyRule(evidence: CampaignEvidence): RecommendationDraft | null {
  if (
    evidence.current.impressions < MIN_PERIOD_IMPRESSIONS ||
    evidence.comparison.impressions < MIN_PERIOD_IMPRESSIONS ||
    evidence.current.spend <= 0 ||
    evidence.comparison.spend <= 0
  ) {
    return null;
  }

  const spendChange = change(evidence.current.spend, evidence.comparison.spend);
  const roasChange = change(evidence.current.roas, evidence.comparison.roas);
  const cpaChange = change(evidence.current.cpa, evidence.comparison.cpa);
  const ctrChange = change(evidence.current.ctr, evidence.comparison.ctr);
  const cpmChange = change(evidence.current.cpm, evidence.comparison.cpm);

  const roasWeak = roasChange !== null && roasChange <= -0.2;
  const cpaWeak = cpaChange !== null && cpaChange >= 0.2;
  const spendExpanded = spendChange !== null && spendChange >= 0.15;
  if (!spendExpanded || (!roasWeak && !cpaWeak)) return null;

  const driverSignals = [
    ctrChange !== null && ctrChange <= -0.15,
    cpmChange !== null && cpmChange >= 0.15,
    cpaWeak,
  ].filter(Boolean).length;
  const magnitude = Math.max(Math.abs(roasChange ?? 0), Math.max(cpaChange ?? 0, 0));
  const severity = magnitude >= 0.35 ? 'HIGH' : 'MEDIUM';
  const support = clamp01(
    Math.min(evidence.current.impressions, evidence.comparison.impressions) / 10_000,
  );
  const parts = priorityParts(
    Math.max(evidence.spendShare, 0.15),
    0.55 + support * 0.25 + Math.min(driverSignals, 2) * 0.1,
    0.5 + clamp01(magnitude) * 0.5,
  );
  const context = recommendationContext({
    baseConfidence: parts.confidenceScore,
    attributionPrecision: 'META_PROVIDER',
  });

  return {
    ruleId: 'campaign_efficiency_deterioration',
    ruleVersion: RULE_VERSION,
    category: 'CAMPAIGN_EFFICIENCY',
    severity,
    entityType: 'CAMPAIGN',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Campaign efficiency weakened while spend increased',
    summary:
      'Observed spend increased versus the comparison period while provider-reported efficiency weakened.',
    suggestedAction:
      'Review campaign delivery, audiences and creatives before increasing spend further.',
    impactScore: parts.impactScore,
    urgencyScore: parts.urgencyScore,
    ...context,
    ...windowFields(evidence),
    evidence: {
      source: 'META_PROVIDER_ATTRIBUTION',
      currency: evidence.currency,
      spendShare: round(evidence.spendShare),
      current: evidence.current,
      comparison: evidence.comparison,
      changes: {
        spend: round(spendChange),
        roas: round(roasChange),
        cpa: round(cpaChange),
        ctr: round(ctrChange),
        cpm: round(cpmChange),
      },
    },
  };
}

export function creativeFatigueRule(evidence: CreativeEvidence): RecommendationDraft | null {
  if (
    evidence.current.impressions < MIN_PERIOD_IMPRESSIONS ||
    evidence.comparison.impressions < MIN_PERIOD_IMPRESSIONS
  ) {
    return null;
  }

  const frequencyChange = change(evidence.current.frequency, evidence.comparison.frequency);
  const ctrChange = change(evidence.current.ctr, evidence.comparison.ctr);
  const cpaChange = change(evidence.current.cpa, evidence.comparison.cpa);
  const roasChange = change(evidence.current.roas, evidence.comparison.roas);

  const repeatExposureUp = frequencyChange !== null && frequencyChange >= 0.2;
  const engagementDown = ctrChange !== null && ctrChange <= -0.2;
  const efficiencyDown =
    (cpaChange !== null && cpaChange >= 0.15) ||
    (roasChange !== null && roasChange <= -0.2);
  if (!repeatExposureUp || !engagementDown || !efficiencyDown) return null;

  const magnitude = Math.max(
    frequencyChange ?? 0,
    Math.abs(ctrChange ?? 0),
    cpaChange ?? Math.abs(roasChange ?? 0),
  );
  const support = clamp01(
    Math.min(evidence.current.impressions, evidence.comparison.impressions) / 15_000,
  );
  const parts = priorityParts(
    Math.max(evidence.spendShare, 0.1),
    0.65 + support * 0.25,
    0.55 + clamp01(magnitude) * 0.45,
  );
  const context = recommendationContext({
    baseConfidence: parts.confidenceScore,
    attributionPrecision: 'META_PROVIDER',
  });

  return {
    ruleId: 'creative_fatigue_symptoms',
    ruleVersion: RULE_VERSION,
    category: 'CREATIVE_FATIGUE',
    severity: magnitude >= 0.4 ? 'HIGH' : 'MEDIUM',
    entityType: 'CREATIVE',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Creative shows historical fatigue symptoms',
    summary:
      'Repeat exposure increased while click-through and conversion efficiency weakened versus the comparison period.',
    suggestedAction:
      'Review or rotate this creative and compare the replacement against the current historical baseline.',
    impactScore: parts.impactScore,
    urgencyScore: parts.urgencyScore,
    ...context,
    ...windowFields(evidence),
    evidence: {
      source: 'META_PROVIDER_ATTRIBUTION',
      currency: evidence.currency,
      spendShare: round(evidence.spendShare),
      current: evidence.current,
      comparison: evidence.comparison,
      changes: {
        frequency: round(frequencyChange),
        ctr: round(ctrChange),
        cpa: round(cpaChange),
        roas: round(roasChange),
      },
      interpretation: 'OBSERVATIONAL_SYMPTOMS_NOT_PREDICTION',
    },
  };
}

export function underexposedProductRule(
  evidence: ProductEvidence,
  window: { start: Date; end: Date },
): RecommendationDraft | null {
  if (
    evidence.units < 5 ||
    evidence.mappingConfidence < MIN_PRODUCT_MAPPING_CONFIDENCE ||
    evidence.revenueShare < 0.08 ||
    evidence.mappedSpendShare >= evidence.revenueShare * 0.6
  ) {
    return null;
  }

  const limitations = productLimitations(evidence);
  const relativeGap = evidence.revenueShare - evidence.mappedSpendShare;
  const parts = priorityParts(
    Math.max(evidence.revenueShare, 0.1),
    (0.55 + evidence.mappingConfidence * 0.25 + Math.min(evidence.mappingCoverage, 1) * 0.2) *
      productCoverageConfidenceFactor(evidence.mappingCoverage),
    clamp01(relativeGap * 3),
  );
  const context = recommendationContext({
    baseConfidence: parts.confidenceScore,
    attributionPrecision: 'EXACT_PRODUCT',
    limitations,
  });

  return {
    ruleId: 'underexposed_commerce_winner',
    ruleVersion: RULE_VERSION,
    category: 'UNDEREXPOSED_PRODUCT',
    severity: relativeGap >= 0.2 ? 'HIGH' : 'MEDIUM',
    entityType: 'PRODUCT',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Strong commerce contribution with relatively low mapped paid exposure',
    summary:
      'This product represents a larger share of Shopify revenue than its share of high-confidence mapped Meta spend.',
    suggestedAction: 'Consider a controlled paid-traffic test rather than an automatic budget increase.',
    impactScore: parts.impactScore,
    urgencyScore: parts.urgencyScore,
    ...context,
    observationStart: window.start,
    observationEnd: window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'SHOPIFY_PLUS_MAPPED_META',
      revenue: round(evidence.netRevenue, 2),
      units: evidence.units,
      revenueShare: round(evidence.revenueShare),
      mappedMetaSpend: round(evidence.mappedMetaSpend, 2),
      mappedSpendShare: round(evidence.mappedSpendShare),
      mappingConfidence: round(evidence.mappingConfidence),
      mappingCoverage: round(evidence.mappingCoverage),
    },
  };
}

export function paidCommerceMismatchRule(
  evidence: ProductEvidence,
  window: { start: Date; end: Date },
): RecommendationDraft | null {
  const hasCommerceSupport = evidence.units >= 2;
  const hasPaidSupport = evidence.mappedImpressions >= MIN_PERIOD_IMPRESSIONS;
  if (
    (!hasCommerceSupport && !hasPaidSupport) ||
    evidence.mappingConfidence < MIN_PRODUCT_MAPPING_CONFIDENCE ||
    evidence.mappedSpendShare < 0.08 ||
    evidence.revenueShare > evidence.mappedSpendShare * 0.55
  ) {
    return null;
  }

  const limitations = productLimitations(evidence);
  const gap = evidence.mappedSpendShare - evidence.revenueShare;
  const impressionSupport = clamp01(evidence.mappedImpressions / 10_000);
  const parts = priorityParts(
    Math.max(evidence.mappedSpendShare, 0.1),
    (0.5 + evidence.mappingConfidence * 0.2 + Math.min(evidence.mappingCoverage, 1) * 0.2 + impressionSupport * 0.1) *
      productCoverageConfidenceFactor(evidence.mappingCoverage),
    clamp01(gap * 3),
  );
  const context = recommendationContext({
    baseConfidence: parts.confidenceScore,
    attributionPrecision: 'EXACT_PRODUCT',
    limitations,
  });

  return {
    ruleId: 'paid_commerce_exposure_mismatch',
    ruleVersion: RULE_VERSION,
    category: 'PAID_COMMERCE_MISMATCH',
    severity: gap >= 0.2 ? 'HIGH' : 'MEDIUM',
    entityType: 'PRODUCT',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Paid exposure is high relative to observed commerce contribution',
    summary:
      'High-confidence mapped Meta spend represents a materially larger share than this product contributes to Shopify revenue.',
    suggestedAction: 'Investigate traffic fit, product offer and landing experience before increasing exposure.',
    impactScore: parts.impactScore,
    urgencyScore: parts.urgencyScore,
    ...context,
    observationStart: window.start,
    observationEnd: window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'SHOPIFY_PLUS_MAPPED_META',
      revenue: round(evidence.netRevenue, 2),
      units: evidence.units,
      revenueShare: round(evidence.revenueShare),
      mappedMetaSpend: round(evidence.mappedMetaSpend, 2),
      mappedImpressions: evidence.mappedImpressions,
      mappedSpendShare: round(evidence.mappedSpendShare),
      mappingConfidence: round(evidence.mappingConfidence),
      mappingCoverage: round(evidence.mappingCoverage),
    },
  };
}

export function marginTrapRule(
  evidence: ProductEvidence,
  window: { start: Date; end: Date },
): RecommendationDraft | null {
  if (
    evidence.costCoverage < 0.8 ||
    evidence.providerRoas === null ||
    evidence.providerRoas < 1.5 ||
    evidence.contributionAfterAds === null ||
    evidence.contributionAfterAds > 0
  ) {
    return null;
  }

  const limitations = productLimitations(evidence);
  const parts = priorityParts(
    Math.max(evidence.mappedSpendShare, evidence.revenueShare),
    (0.65 + evidence.costCoverage * 0.25 + evidence.mappingConfidence * 0.1) *
      productCoverageConfidenceFactor(evidence.mappingCoverage),
    0.8,
  );
  const context = recommendationContext({
    baseConfidence: parts.confidenceScore,
    attributionPrecision: 'EXACT_PRODUCT',
    limitations,
  });

  return {
    ruleId: 'provider_roas_margin_trap',
    ruleVersion: RULE_VERSION,
    category: 'MARGIN_TRAP',
    severity: 'HIGH',
    entityType: 'PRODUCT',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Strong provider ROAS does not translate into contribution after ads',
    summary:
      'Meta-attributed return looks positive, but observed product cost and mapped ad spend leave contribution after ads at or below zero.',
    suggestedAction: 'Review product economics before treating provider ROAS as a scaling signal.',
    impactScore: parts.impactScore,
    urgencyScore: parts.urgencyScore,
    ...context,
    observationStart: window.start,
    observationEnd: window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'SHOPIFY_ECONOMICS_PLUS_MAPPED_META',
      providerRoas: round(evidence.providerRoas),
      contributionBeforeAds: round(evidence.contributionBeforeAds, 2),
      contributionAfterAds: round(evidence.contributionAfterAds, 2),
      mappedMetaSpend: round(evidence.mappedMetaSpend, 2),
      costCoverage: round(evidence.costCoverage),
      mappingConfidence: round(evidence.mappingConfidence),
      mappingCoverage: round(evidence.mappingCoverage),
    },
  };
}

export function inventorySpendConflictRule(
  evidence: ProductEvidence,
  window: { start: Date; end: Date },
): RecommendationDraft | null {
  if (
    !evidence.inventoryTrusted ||
    evidence.daysCover === null ||
    evidence.daysCover > 10 ||
    evidence.daysCover < 0 ||
    evidence.mappedMetaSpend <= 0 ||
    evidence.recentUnitsPerDay === null ||
    evidence.recentUnitsPerDay <= 0
  ) {
    return null;
  }

  const limitations = productLimitations(evidence);
  const urgency = clamp01((10 - evidence.daysCover) / 10 + 0.4);
  const parts = priorityParts(
    Math.max(evidence.revenueShare, evidence.mappedSpendShare),
    0.8 * productCoverageConfidenceFactor(evidence.mappingCoverage),
    urgency,
  );
  const context = recommendationContext({
    baseConfidence: parts.confidenceScore,
    attributionPrecision: 'EXACT_PRODUCT',
    limitations,
  });

  return {
    ruleId: 'inventory_spend_conflict',
    ruleVersion: RULE_VERSION,
    category: 'INVENTORY_SPEND_CONFLICT',
    severity: evidence.daysCover <= 5 ? 'CRITICAL' : 'HIGH',
    entityType: 'PRODUCT',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Paid exposure is supporting a product with limited observed stock cover',
    summary:
      'Trusted Shopify inventory and recent observed unit velocity imply limited cover while mapped Meta spend remains active.',
    suggestedAction: 'Protect inventory or confirm replenishment before aggressive paid scaling.',
    impactScore: parts.impactScore,
    urgencyScore: parts.urgencyScore,
    ...context,
    observationStart: window.start,
    observationEnd: window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'TRUSTED_SHOPIFY_INVENTORY_PLUS_MAPPED_META',
      stockAvailable: evidence.stockAvailable,
      recentUnitsPerDay: round(evidence.recentUnitsPerDay, 2),
      daysCover: round(evidence.daysCover, 2),
      mappedMetaSpend: round(evidence.mappedMetaSpend, 2),
      mappingCoverage: round(evidence.mappingCoverage),
      inventoryInterpretation: 'CURRENT_VELOCITY_RUNWAY_NOT_FORECAST',
    },
  };
}

export function sharedExposureInventoryRule(
  evidence: SharedExposureEvidence,
  window: { start: Date; end: Date },
): RecommendationDraft | null {
  if (
    !evidence.inventoryTrusted ||
    evidence.sharedAdSpend <= 0 ||
    evidence.impressions < MIN_PERIOD_IMPRESSIONS ||
    (!evidence.merchantConfirmed && evidence.scopeConfidence < MIN_PRODUCT_MAPPING_CONFIDENCE)
  ) {
    return null;
  }

  const affected = evidence.products
    .filter(
      (product) =>
        product.daysCover !== null &&
        product.daysCover >= 0 &&
        product.daysCover <= 10 &&
        product.recentUnitsPerDay !== null &&
        product.recentUnitsPerDay > 0,
    )
    .sort((left, right) => (left.daysCover ?? Infinity) - (right.daysCover ?? Infinity));
  if (affected.length === 0) return null;

  const minimumDaysCover = affected[0]!.daysCover!;
  const limitations: RecommendationLimitation[] = [
    {
      code: 'SHARED_SPEND_NOT_ALLOCATED',
      message:
        'Meta spend is known at the ad level and is not divided between the promoted products without provider-level allocation evidence.',
    },
  ];
  if (evidence.scope === 'COLLECTION') {
    limitations.push({
      code: 'CURRENT_COLLECTION_MEMBERSHIP',
      message:
        'Affected products are based on the collection membership currently stored from Shopify, not reconstructed historical membership.',
    });
    if (evidence.collectionMembershipTruncated) {
      limitations.push({
        code: 'COLLECTION_MEMBERSHIP_TRUNCATED',
        message:
          'This recommendation evaluated a bounded sample of current collection members. Additional collection products were not expanded in this snapshot.',
      });
    }
  }

  const urgency = clamp01((10 - minimumDaysCover) / 10 + 0.4);
  const support = clamp01(evidence.impressions / 15_000);
  const baseConfidence =
    (evidence.merchantConfirmed ? 0.82 : 0.62 + evidence.scopeConfidence * 0.18) + support * 0.08;
  const context = recommendationContext({
    baseConfidence,
    attributionPrecision:
      evidence.scope === 'COLLECTION' ? 'COLLECTION' : 'SHARED_MULTI_PRODUCT',
    limitations,
  });

  return {
    ruleId: 'shared_exposure_inventory_conflict',
    ruleVersion: RULE_VERSION,
    category: 'INVENTORY_SPEND_CONFLICT',
    severity: minimumDaysCover <= 5 ? 'CRITICAL' : 'HIGH',
    entityType: 'AD',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title:
      evidence.scope === 'COLLECTION'
        ? 'Collection ad includes products with limited observed stock cover'
        : 'Multi-product ad includes products with limited observed stock cover',
    summary:
      'Trusted Shopify inventory shows limited observed cover for one or more products promoted by this shared-exposure ad while Meta spend remains active.',
    suggestedAction:
      'Review the affected products and replenishment plan before increasing this shared ad exposure. Do not infer spend per product from the shared ad total.',
    impactScore: clamp01(Math.max(0.2, evidence.sharedAdSpend > 0 ? 0.55 : 0)),
    urgencyScore: urgency,
    ...context,
    observationStart: window.start,
    observationEnd: window.end,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'TRUSTED_SHOPIFY_INVENTORY_PLUS_SHARED_META_EXPOSURE',
      scope: evidence.scope,
      currency: evidence.currency,
      sharedAdSpend: round(evidence.sharedAdSpend, 2),
      impressions: evidence.impressions,
      scopeConfidence: round(evidence.scopeConfidence),
      merchantConfirmed: evidence.merchantConfirmed,
      collectionMembershipTruncated: evidence.collectionMembershipTruncated,
      affectedProducts: affected.map((product) => ({
        entityId: product.entityId,
        externalEntityId: product.externalEntityId,
        name: product.name,
        stockAvailable: product.stockAvailable,
        recentUnitsPerDay: round(product.recentUnitsPerDay, 2),
        daysCover: round(product.daysCover, 2),
      })),
      collections: evidence.collections,
      inventoryInterpretation: 'CURRENT_VELOCITY_RUNWAY_NOT_FORECAST',
      spendInterpretation: 'AD_LEVEL_SHARED_EXPOSURE_NOT_PRODUCT_LEVEL_ATTRIBUTION',
    },
  };
}
