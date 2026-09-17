export interface HistoricalMetrics {
  spend: number;
  impressions: number;
  reach: number | null;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  roas: number | null;
  cpa: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  frequency: number | null;
}

export interface EvidenceWindow {
  start: Date;
  end: Date;
  current: HistoricalMetrics;
  comparison: HistoricalMetrics;
}

export interface CampaignEvidence extends EvidenceWindow {
  entityId: string;
  externalEntityId: string;
  name: string;
  currency: string;
  spendShare: number;
}

export interface CreativeEvidence extends EvidenceWindow {
  entityId: string;
  externalEntityId: string;
  name: string;
  currency: string;
  spendShare: number;
}

export interface ProductEvidence {
  entityId: string;
  externalEntityId: string;
  name: string;
  currency: string;
  revenue: number;
  netRevenue: number;
  units: number;
  revenueShare: number;
  mappedMetaSpend: number;
  mappedImpressions: number;
  mappedSpendShare: number;
  mappedProviderValue: number;
  providerRoas: number | null;
  mappingConfidence: number;
  mappingCoverage: number;
  contributionBeforeAds: number | null;
  contributionAfterAds: number | null;
  costCoverage: number;
  inventoryTrusted: boolean;
  stockAvailable: number | null;
  recentUnitsPerDay: number | null;
  daysCover: number | null;
}

export interface SharedExposureProductEvidence {
  entityId: string;
  externalEntityId: string;
  name: string;
  stockAvailable: number | null;
  recentUnitsPerDay: number | null;
  daysCover: number | null;
}

export interface SharedExposureEvidence {
  entityId: string;
  externalEntityId: string;
  name: string;
  currency: string;
  scope: 'MULTI_PRODUCT' | 'COLLECTION';
  scopeConfidence: number;
  merchantConfirmed: boolean;
  sharedAdSpend: number;
  impressions: number;
  inventoryTrusted: boolean;
  products: SharedExposureProductEvidence[];
  collectionMembershipTruncated: boolean;
  collections: Array<{
    id: string;
    shopifyCollectionId: string;
    title: string;
    handle: string | null;
    productCount: number;
    evaluatedProductCount: number;
    membershipTruncated: boolean;
  }>;
}

export interface StorefrontFunnelMetrics {
  sessions: number;
  productViewSessions: number;
  addToCartSessions: number;
  cartViewSessions: number;
  cartViewCheckoutSessions: number;
  cartViewPurchaseSessions: number;
  checkoutStartSessions: number;
  checkoutCompletedSessions: number;
  linkedPurchaseSessions: number;
  productViewRate: number | null;
  viewToCartRate: number | null;
  cartViewToCheckoutRate: number | null;
  cartViewToPurchaseRate: number | null;
  cartViewAbandonmentRate: number | null;
  checkoutCompletionRate: number | null;
  checkoutAbandonmentRate: number | null;
  linkedPurchaseRate: number | null;
}

export interface StorefrontEvidence {
  entityType: 'STORE' | 'PRODUCT' | 'LANDING_PAGE';
  entityId: string | null;
  externalEntityId: string | null;
  name: string;
  current: StorefrontFunnelMetrics;
  comparison: StorefrontFunnelMetrics;
  qualityState: 'READY' | 'DEGRADED' | 'NOT_READY';
  limitations: string[];
}

export type RecommendationCategory =
  | 'CAMPAIGN_EFFICIENCY'
  | 'CREATIVE_FATIGUE'
  | 'UNDEREXPOSED_PRODUCT'
  | 'PAID_COMMERCE_MISMATCH'
  | 'MARGIN_TRAP'
  | 'INVENTORY_SPEND_CONFLICT'
  | 'STOREFRONT_CONVERSION'
  | 'CART_ABANDONMENT'
  | 'CHECKOUT_ABANDONMENT'
  | 'PRODUCT_CONVERSION'
  | 'LANDING_PAGE_QUALITY'
  | 'MAPPING_HEALTH'
  | 'INVENTORY_RISK';

export type RecommendationSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RecommendationEntityType =
  | 'STORE'
  | 'CAMPAIGN'
  | 'AD_SET'
  | 'AD'
  | 'CREATIVE'
  | 'PRODUCT'
  | 'VARIANT'
  | 'COLLECTION'
  | 'LANDING_PAGE';

export type RecommendationEvidenceQuality = 'HIGH' | 'MEDIUM' | 'LOW';
export type RecommendationAttributionPrecision =
  | 'META_PROVIDER'
  | 'EXACT_PRODUCT'
  | 'SHARED_MULTI_PRODUCT'
  | 'COLLECTION'
  | 'STORE'
  | 'UNKNOWN';

export type DecisionAction =
  | 'SCALE'
  | 'HOLD'
  | 'REDUCE'
  | 'PAUSE'
  | 'TEST'
  | 'INVESTIGATE';

export type DecisionConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type RecommendationLifecycleState = 'OPEN' | 'REVIEWED' | 'DISMISSED' | 'RESOLVED';

export interface RecommendationLimitation {
  code: string;
  message: string;
}

export interface RecommendationDraft {
  ruleId: string;
  ruleVersion: string;
  category: RecommendationCategory;
  severity: RecommendationSeverity;
  entityType: RecommendationEntityType;
  entityId: string | null;
  externalEntityId: string | null;
  title: string;
  summary: string;
  suggestedAction: string;
  impactScore: number;
  confidenceScore: number;
  urgencyScore: number;
  evidenceQuality: RecommendationEvidenceQuality;
  attributionPrecision: RecommendationAttributionPrecision;
  limitations: RecommendationLimitation[];
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date | null;
  comparisonEnd: Date | null;
  evidence: Record<string, unknown>;
  blockers?: Record<string, unknown>;
}

export interface RecommendationDecisionMetadata {
  decisionAction: DecisionAction;
  decisionConfidence: DecisionConfidence;
  decisionBasis: 'DETERMINISTIC_RULE';
  decisionMessage: string;
}

export interface DataQualityEvidence {
  code: string;
  status: 'HEALTHY' | 'WARNING' | 'BLOCKED';
  surface: string;
  message: string;
  metrics?: Record<string, unknown>;
}
