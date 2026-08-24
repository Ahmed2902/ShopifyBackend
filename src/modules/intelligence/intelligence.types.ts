export type AdvertisingPlatform = 'META' | 'TIKTOK';
export type DeliveryGroupKind = 'AD_SET' | 'AD_GROUP';

export type CampaignRole =
  | 'PROSPECTING'
  | 'RETARGETING'
  | 'RETENTION'
  | 'CATALOG'
  | 'PRODUCT_LAUNCH'
  | 'BRAND'
  | 'UNKNOWN';

export type EvidenceConfidence = 'INSUFFICIENT' | 'LOW' | 'MODERATE' | 'HIGH';
export type InventoryRisk = 'UNKNOWN' | 'HEALTHY' | 'LOW' | 'CRITICAL';
export type CreativeFatigue = 'INSUFFICIENT' | 'LOW' | 'MODERATE' | 'HIGH';
export type CommerceTrend = 'UP' | 'STABLE' | 'DOWN' | 'UNKNOWN';

export type CandidateAction =
  | 'NO_RECOMMENDATION'
  | 'HOLD'
  | 'SCALE'
  | 'REDUCE'
  | 'COLLECT_MORE_DATA'
  | 'REVIEW_MAPPING'
  | 'REPLACE_CREATIVE'
  | 'REVIEW_LANDING_PAGE';

export interface NormalizedDailyMetrics {
  date: Date;
  spend: number;
  impressions: number;
  reach: number | null;
  clicks: number;
  outboundClicks: number | null;
  conversions: number;
  conversionValue: number;
  frequency: number | null;
}

export interface MetricWindow {
  days: 1 | 3 | 7 | 14 | 30;
  spend: number;
  impressions: number;
  reach: number | null;
  clicks: number;
  outboundClicks: number | null;
  conversions: number;
  conversionValue: number;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  cvr: number | null;
  cpa: number | null;
  roas: number | null;
  frequency: number | null;
}

export interface FinancialDecisionContext {
  mappingConfidence: number | null;
  inventoryRisk: InventoryRisk;
  breakEvenRoas: number | null;
  contributionMarginRatio: number | null;
  commerceTrend: CommerceTrend;
  dataFreshnessHours: number | null;
  hoursSinceMaterialCampaignChange: number | null;
}

export interface CandidateDecision {
  action: CandidateAction;
  confidence: EvidenceConfidence;
  reasons: string[];
  blockers: string[];
  financialAction: boolean;
}

export interface NormalizedCampaignIdentity {
  platform: AdvertisingPlatform;
  accountId: string;
  campaignId: string;
  campaignName: string;
  role: CampaignRole;
  roleEvidence: string[];
  status: string | null;
  objective: string | null;
}

export interface ProductInventoryFeature {
  productId: string;
  title: string;
  available: number;
  incoming: number;
  units7d: number;
  units30d: number;
  revenue30d: number;
  dailyVelocity: number;
  runwayDays: number | null;
  inventoryRisk: InventoryRisk;
}
