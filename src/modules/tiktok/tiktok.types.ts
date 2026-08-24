import type { ConnectionStatus } from '../../generated/prisma/client.js';

export interface TikTokOAuthContext {
  nonce: string;
  userId: string;
  storeId: string;
  expiresAt: number;
}

export interface TikTokApiContext {
  connectionId: string;
  storeId: string;
  status: ConnectionStatus;
  accessToken: string;
  apiVersion: string;
  scopes: string[];
  businessCenterId: string | null;
  selectedAdvertiserIds: string[];
  selectedCatalogIds: string[];
}

export interface TikTokApiEnvelope<T> {
  code: number;
  message: string;
  request_id?: string;
  data: T;
}

export interface TikTokPageInfo {
  page?: number;
  page_size?: number;
  total_number?: number;
  total_page?: number;
}

export interface TikTokPagedData<T> {
  list: T[];
  page_info?: TikTokPageInfo;
}

export interface TikTokAuthorizedAdvertiser {
  advertiser_id: string;
  advertiser_name?: string;
}

export interface TikTokBusinessCenter {
  bc_id: string;
  name?: string;
  status?: string;
  currency?: string;
  timezone?: string;
  [key: string]: unknown;
}

export interface TikTokAdvertiserRecord {
  advertiser_id: string;
  name?: string;
  advertiser_name?: string;
  status?: string;
  currency?: string;
  timezone?: string;
  timezone_name?: string;
  country?: string;
  country_code?: string;
  industry?: string;
  company?: string;
  balance?: string | number;
  [key: string]: unknown;
}

export type TikTokObject = Record<string, unknown>;
