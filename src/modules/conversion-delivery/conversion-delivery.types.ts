import type { MatchEvidence } from './matching.js';
import type {
  AdvertisingProvider,
  ConversionDelivery,
  ConversionDestination,
} from '../../generated/prisma/client.js';

export const GOOGLE_DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';

export type GoogleConsentMode = 'ACCOUNT_DEFAULT' | 'GRANTED';
export type ConversionAuthSource = 'META_CONNECTION';

export type ConversionDestinationConfig = {
  enhancedMatching?: boolean;
  funnelEvents?: boolean;
  testEventCode?: string;
  customerId?: string;
  loginCustomerId?: string;
  googleConsentMode?: GoogleConsentMode;
  authSource?: ConversionAuthSource;
  adAccountId?: string;
};

export type PurchaseCandidate = {
  sourceEventId?: string | null;
  sourceGenerationAt?: Date | null;
  browserMatchAvailable?: boolean;
  orderId: string;
  storeId: string;
  shopifyOrderId: string;
  eventAt: Date;
  value: string;
  currencyCode: string;
  eventSourceUrl: string | null;
  metaClickId: string | null;
  metaClickEventAt: Date | null;
  googleClickIdKind?: string | null;
  googleClickId: string | null;
  googleClickEventAt: Date | null;
  tiktokClickId: string | null;
  tiktokClickEventAt: Date | null;
};

export type DeliveryClaim = ConversionDelivery & {
  destination: ConversionDestination;
  customerIdentityKey?: string;
  match?: MatchEvidence;
};

export type ProviderDeliveryResult = {
  providerRequestId: string | null;
};

// Required after any asynchronous credential preparation and before the provider HTTP request.
export type BeforeConversionSend = () => Promise<void>;

export type ConfigureDestinationInput = {
  provider: AdvertisingProvider;
  externalId: string;
  displayName?: string | null;
  accessToken?: string | null;
  config: ConversionDestinationConfig;
};
