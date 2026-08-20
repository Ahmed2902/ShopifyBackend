export interface ShopifyShopQueryData {
  shop: unknown;
}

export interface ShopifyProductsQueryData {
  products: unknown;
}

export interface ShopifyVariantsQueryData {
  productVariants: unknown;
}

export interface ShopifyLocationsQueryData {
  locations: unknown;
}

export interface ShopifyLocationInventoryQueryData {
  location: { inventoryLevels: unknown } | null;
}

export interface PlainShopifyTokenSet {
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  refreshTokenExpiresAt: Date;
  scopes: string[];
}

export interface ShopifyConnectionCredentialState {
  id: string;
  accessTokenCiphertext: string;
  accessTokenExpiresAt: Date | null;
  refreshTokenCiphertext: string | null;
  refreshTokenExpiresAt: Date | null;
  refreshClaimedAt?: Date | null;
  scopes: string[];
}

export interface ShopifyRequestContext {
  storeId: string;
  shop: string;
  accessToken: string;
  connectionId: string;
  apiVersion: string;
}

export interface ShopifySyncContext extends ShopifyRequestContext {
  syncRunId: string;
}

export interface ShopifySyncStats {
  read: number;
  written: number;
}

export interface ShopifyResourceSyncStats extends ShopifySyncStats {
  ids: string[];
}

export type ShopifyLocationSyncStats = ShopifyResourceSyncStats;

export type ShopifyInventorySnapshotSource =
  | 'INITIAL_SYNC'
  | 'WEBHOOK_RECONCILIATION'
  | 'PERIODIC_RECONCILIATION'
  | 'MANUAL_RECONCILIATION';
