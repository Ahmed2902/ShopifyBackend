import type {
  ShopifyOrderHeader,
  ShopifyOrderLineItem,
} from './shopify-order.schema.js';

export interface ShopifyRefundQueryData {
  refund: unknown;
}

export type ShopifyImportedOrder = ShopifyOrderHeader & {
  lineItems: ShopifyOrderLineItem[];
};

export interface PersistedShopifyOrder {
  id: string;
  lineItems: Array<{
    id: string;
    shopifyLineItemId: string;
  }>;
}

export interface ShopifyOrderBackfillBreakdown {
  orders: number;
  lineItems: number;
  refunds: number;
  refundLineItems: number;
}

export interface ShopifyOrderBackfillResult {
  recordsRead: number;
  recordsWritten: number;
  breakdown: ShopifyOrderBackfillBreakdown;
}

export type ShopifyOrderBackfillInspection =
  | {
      state: 'RUNNING';
      providerStatus: string;
      objectCount: string | number | null;
    }
  | {
      state: 'FAILED';
      providerStatus: string;
      errorCode: string | null;
    }
  | ({
      state: 'COMPLETED';
      providerStatus: 'COMPLETED';
    } & ShopifyOrderBackfillResult);
