export const V1_TRIAL_DAYS = 14;

export const STRIDE_PLAN_CATALOG = {
  ESSENTIALS: {
    code: 'ESSENTIALS' as const,
    name: 'Essentials',
    monthlyUsd: 49.99,
    currency: 'USD' as const,
    billingPeriod: 'EVERY_30_DAYS' as const,
    maxAdChannels: 1,
    recommendationLimit: 10,
    sessionExplorer: true,
    storefrontFunnels: true,
    productAds: true,
    inventoryIntelligence: true,
    readOnlyMcp: true,
    visitorJourneys: false,
    advancedAttribution: false,
    crossChannelIntelligence: false,
    serverSideConversions: 'SELECTED_PROVIDER' as const,
  },
  PRO: {
    code: 'PRO' as const,
    name: 'Pro',
    monthlyUsd: 84.99,
    currency: 'USD' as const,
    billingPeriod: 'EVERY_30_DAYS' as const,
    maxAdChannels: null,
    recommendationLimit: 50,
    sessionExplorer: true,
    storefrontFunnels: true,
    productAds: true,
    inventoryIntelligence: true,
    readOnlyMcp: true,
    visitorJourneys: true,
    advancedAttribution: true,
    crossChannelIntelligence: true,
    serverSideConversions: 'ALL_CONFIGURED_PROVIDERS' as const,
  },
} as const;

export type V1BillingPlan = keyof typeof STRIDE_PLAN_CATALOG;
export type V1AdProvider = 'META' | 'TIKTOK' | 'GOOGLE_ADS';
