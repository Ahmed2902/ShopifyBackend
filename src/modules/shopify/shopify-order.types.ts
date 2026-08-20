export interface ShopifyOrdersQueryData {
  orders: unknown;
}

export interface ShopifyOrderLineItemsQueryData {
  order: { lineItems: unknown } | null;
}

export interface ShopifyRefundLineItemsQueryData {
  refund: { refundLineItems: unknown } | null;
}

export interface PersistedShopifyOrder {
  id: string;
  lineItems: Array<{
    id: string;
    shopifyLineItemId: string;
  }>;
}

export interface ShopifyOrderSyncBreakdown {
  orders: number;
  lineItems: number;
  refunds: number;
  refundLineItems: number;
}

export interface ShopifyOrderSyncResult {
  recordsRead: number;
  recordsWritten: number;
  checkpointCursor: string | null;
  breakdown: ShopifyOrderSyncBreakdown;
}
