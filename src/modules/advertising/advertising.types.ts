import type { IntegrationProviderName } from '../integrations/integration.schema.js';

export type AdvertisingPlatform = Exclude<IntegrationProviderName, 'SHOPIFY'>;
export type AdvertisingDeliveryGroupKind = 'AD_SET' | 'AD_GROUP';

export interface AdvertisingAccountSummary {
  platform: AdvertisingPlatform;
  externalId: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  status: string | null;
}

export interface AdvertisingCampaignSummary {
  platform: AdvertisingPlatform;
  externalId: string;
  accountExternalId: string;
  name: string;
  objective: string | null;
  status: string | null;
  budget: string | null;
  budgetMode: string | null;
}

export interface AdvertisingDeliveryGroupSummary {
  platform: AdvertisingPlatform;
  kind: AdvertisingDeliveryGroupKind;
  externalId: string;
  campaignExternalId: string;
  name: string;
  status: string | null;
  optimizationGoal: string | null;
  budget: string | null;
  budgetMode: string | null;
}

export interface AdvertisingAdSummary {
  platform: AdvertisingPlatform;
  externalId: string;
  campaignExternalId: string;
  deliveryGroupExternalId: string;
  name: string;
  status: string | null;
  landingPageUrl: string | null;
  creative: {
    text: string | null;
    callToAction: string | null;
    imageUrl: string | null;
    videoId: string | null;
    raw: unknown;
  };
}

export interface AdvertisingDailyMetrics {
  platform: AdvertisingPlatform;
  date: string;
  accountExternalId: string;
  campaignExternalId?: string | null;
  deliveryGroupExternalId?: string | null;
  adExternalId?: string | null;
  currency: string | null;
  spend: string;
  impressions: string;
  clicks: string;
  reach: string | null;
  ctr: string | null;
  cpc: string | null;
  cpm: string | null;
  frequency: string | null;
  conversions: string | null;
  conversionValue: string | null;
  costPerConversion: string | null;
  roas: string | null;
  video: {
    watched2s: string | null;
    watched6s: string | null;
    p25: string | null;
    p50: string | null;
    p75: string | null;
    p100: string | null;
  };
}
