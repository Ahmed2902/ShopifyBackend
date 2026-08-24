export type IntelligenceProvider = 'META' | 'TIKTOK';
export type IntelligenceDecision = 'SCALE' | 'HOLD' | 'REDUCE' | 'PAUSE' | 'TEST' | 'MORE_DATA';

export type ProviderSignal = {
  provider: IntelligenceProvider;
  ads: number;
  activeAds: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  roas: number | null;
};

export type ProductSignal = {
  productId: string;
  title: string;
  status: string;
  tracksInventory: boolean;
  available: number;
  incoming: number;
  nextRestockAt: Date | null;
  unitsSold: number;
  orderCount: number;
  mappingConfidence: number | null;
  mappingConfirmed: boolean;
  sharedAdMapping: boolean;
  providers: ProviderSignal[];
};

export type IntelligenceDataset = {
  connections: {
    shopify: string | null;
    meta: string | null;
    tiktok: string | null;
  };
  products: ProductSignal[];
};
