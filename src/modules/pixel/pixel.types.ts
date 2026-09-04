export const STOREFRONT_EVENT_NAMES = [
  'PAGE_VIEW',
  'PRODUCT_VIEW',
  'COLLECTION_VIEW',
  'SEARCH',
  'ADD_TO_CART',
  'REMOVE_FROM_CART',
  'BEGIN_CHECKOUT',
  'CHECKOUT_PROGRESS',
  'CHECKOUT_COMPLETED',
] as const;

export type StorefrontEventName = (typeof STOREFRONT_EVENT_NAMES)[number];

export const STOREFRONT_CONSENT_STATES = [
  'UNKNOWN',
  'GRANTED',
  'DENIED',
  'NOT_REQUIRED',
] as const;

export type StorefrontConsentState = (typeof STOREFRONT_CONSENT_STATES)[number];

export const STOREFRONT_JOURNEY_SOURCES = [
  'META',
  'GOOGLE',
  'TIKTOK',
  'UTM',
  'REFERRER',
  'DIRECT',
  'UNKNOWN',
] as const;

export type StorefrontJourneySource = (typeof STOREFRONT_JOURNEY_SOURCES)[number];

export const PIXEL_EVENT_VERSION = 1 as const;
export const PIXEL_DEFAULT_RETENTION_DAYS = 90;
export const PIXEL_MAX_RETENTION_DAYS = 365;
export const PIXEL_MAX_BATCH_SIZE = 50;
export const PIXEL_COLLECTOR_TOKEN_BYTES = 32;
export const PIXEL_CLEANUP_BATCH_SIZE = 1_000;

export interface StorefrontAttributionInput {
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmContent?: string;
  utmTerm?: string;
  metaClickId?: string;
  googleClickId?: string;
  tiktokClickId?: string;
  metaCampaignExternalId?: string;
  metaAdSetExternalId?: string;
  metaAdExternalId?: string;
}
