export interface HistoricalMetrics {
  spend: number;
  impressions: number;
  reach: number;
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

export type RecommendationCategory =
  | 'CAMPAIGN_EFFICIENCY'
  | 'CREATIVE_FATIGUE'
  | 'UNDEREXPOSED_PRODUCT'
  | 'PAID_COMMERCE_MISMATCH'
  | 'MARGIN_TRAP'
  | 'INVENTORY_SPEND_CONFLICT'
  | 'DATA_QUALITY';

export type RecommendationSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type RecommendationEntityType =
  | 'STORE'
  | 'CAMPAIGN'
  | 'AD_SET'
  | 'AD'
  | 'CREATIVE'
  | 'PRODUCT'
  | 'VARIANT'
  | 'COLLECTION';

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
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date | null;
  comparisonEnd: Date | null;
  evidence: Record<string, unknown>;
  blockers?: Record<string, unknown>;
}

export interface DataQualityEvidence {
  code: string;
  status: 'HEALTHY' | 'WARNING' | 'BLOCKED';
  surface: string;
  message: string;
  metrics?: Record<string, unknown>;
}
