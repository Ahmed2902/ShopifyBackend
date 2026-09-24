export type GoogleAdsObject = Record<string, unknown>;

export type GoogleAdsApiContext = {
  connectionId: string;
  storeId: string;
  accessToken: string;
  apiVersion: string;
  scopes: string[];
  selectedCustomerIds: string[];
};

export type GoogleAdsDiscoveredCustomer = {
  customerId: string;
  loginCustomerId: string | null;
  descriptiveName: string;
  status: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  manager: boolean;
  testAccount: boolean;
  level: number | null;
  parentCustomerId: string | null;
  raw: unknown;
};

export type GoogleAdsSyncStats = {
  recordsRead: number;
  recordsWritten: number;
  partial: boolean;
  failures: Array<{ customerId: string; stage: string; code: string }>;
};
