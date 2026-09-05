export type MetaAuthorizationMode = 'READ_ONLY' | 'ADS_MANAGEMENT';

export interface MetaOAuthContext {
  nonce: string;
  userId: string;
  storeId: string;
  authorizationMode: MetaAuthorizationMode;
  expiresAt: number;
}

export interface MetaTokenExchange {
  accessToken: string;
  expiresInSeconds: number | null;
}

export interface MetaTokenInspection {
  appId: string;
  userId: string;
  isValid: boolean;
  expiresAt: Date | null;
  scopes: string[];
}

export interface MetaApiContext {
  storeId: string;
  connectionId: string;
  accessToken: string;
  apiVersion: string;
}

export interface MetaBusinessAsset {
  id: string;
  name: string;
}

export interface MetaAdAccountAsset {
  id: string;
  accountId: string;
  name: string;
  accountStatus: number | null;
  currency: string;
  timezoneName: string | null;
  timezoneId: number | null;
  timezoneOffsetHoursUtc: number | null;
  amountSpentMinor: bigint | null;
  balanceMinor: bigint | null;
  spendCapMinor: bigint | null;
  business: { id: string; name?: string } | null;
  raw: unknown;
}

export interface MetaCatalogAsset {
  id: string;
  name: string;
  businessId: string | null;
  ownerBusinessId: string | null;
  vertical: string | null;
  productCount: number | null;
  feedCount: number | null;
  raw: unknown;
}
