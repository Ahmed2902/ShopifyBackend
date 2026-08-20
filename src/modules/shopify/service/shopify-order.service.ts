import { AppError } from '../../../errors/app-error.js';
import type { IntegrationService } from '../../integrations/integration.service.js';
import type { ShopifyOrderRepository } from '../shopify-order.repository.js';
import {
  ORDER_LINE_ITEMS_QUERY,
  ORDERS_QUERY,
  REFUND_LINE_ITEMS_QUERY,
} from '../shopify-order.queries.js';
import {
  shopifyOrderConnectionSchema,
  shopifyOrderLineItemConnectionSchema,
  shopifyRefundLineItemConnectionSchema,
  type ShopifyOrder,
  type ShopifyOrderLineItem,
  type ShopifyRefund,
  type ShopifyRefundLineItem,
} from '../shopify-order.schema.js';
import type {
  ShopifyOrderLineItemsQueryData,
  ShopifyOrdersQueryData,
  ShopifyOrderSyncResult,
  ShopifyRefundLineItemsQueryData,
} from '../shopify-order.types.js';
import type { ShopifySyncContext } from '../shopify.types.js';
import type { ShopifyApiService } from './shopify-api.service.js';

// Keep the top-level query deliberately modest because Shopify enforces a
// single-query cost ceiling and nested connections multiply requested cost.
const ORDER_PAGE_SIZE = 25;
const EMBEDDED_DETAIL_PAGE_SIZE = 10;
const DETAIL_PAGE_SIZE = 100;

interface PageInfo {
  hasNextPage: boolean;
  endCursor: string | null;
}

export class ShopifyOrderService {
  constructor(
    private readonly repository: ShopifyOrderRepository,
    private readonly integrationService: IntegrationService,
    private readonly apiService: ShopifyApiService,
  ) {}

  async sync(input: ShopifySyncContext): Promise<ShopifyOrderSyncResult> {
    const breakdown = {
      orders: 0,
      lineItems: 0,
      refunds: 0,
      refundLineItems: 0,
    };
    let recordsRead = 0;
    let recordsWritten = 0;
    let cursor: string | null = null;

    while (true) {
      const data = await this.apiService.requestAdminGraphql<ShopifyOrdersQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: ORDERS_QUERY,
        variables: {
          first: ORDER_PAGE_SIZE,
          after: cursor,
          lineItemFirst: EMBEDDED_DETAIL_PAGE_SIZE,
          refundLineItemFirst: EMBEDDED_DETAIL_PAGE_SIZE,
        },
      });

      const parsed = shopifyOrderConnectionSchema.safeParse(data.orders);
      if (!parsed.success) {
        throw new AppError(
          'Shopify orders query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }

      await this.integrationService.recordExternalPayload({
        provider: 'SHOPIFY',
        resourceType: 'OrdersPage',
        apiVersion: input.apiVersion,
        payload: parsed.data,
        syncRunId: input.syncRunId,
      });

      for (const orderNode of parsed.data.nodes) {
        const order = await this.hydrateOrder(input, orderNode);
        const persistedOrder = await this.repository.upsertOrderWithLineItems(input.storeId, order);

        breakdown.orders += 1;
        breakdown.lineItems += order.lineItems.nodes.length;
        recordsRead += 1 + order.lineItems.nodes.length;
        recordsWritten += 1 + order.lineItems.nodes.length;

        for (const refund of order.refunds) {
          const persisted = await this.repository.upsertRefundWithLineItems(
            input.storeId,
            persistedOrder,
            refund,
          );
          if (!persisted) {
            throw new AppError(
              'Shopify refund references an order line item that was not synchronized',
              502,
              'SHOPIFY_ORDER_INCONSISTENT',
            );
          }

          breakdown.refunds += 1;
          breakdown.refundLineItems += refund.refundLineItems.nodes.length;
          recordsRead += 1 + refund.refundLineItems.nodes.length;
          recordsWritten += 1 + refund.refundLineItems.nodes.length;
        }
      }

      const nextCursor = parsed.data.pageInfo.hasNextPage
        ? this.requireNextCursor(parsed.data.pageInfo, 'orders')
        : parsed.data.pageInfo.endCursor;
      await this.integrationService.updateSyncRunProgress(input.syncRunId, {
        cursor: nextCursor,
        recordsRead,
        recordsWritten,
      });

      cursor = nextCursor;
      if (!parsed.data.pageInfo.hasNextPage) break;
    }

    return {
      recordsRead,
      recordsWritten,
      checkpointCursor: cursor,
      breakdown,
    };
  }

  private async hydrateOrder(
    input: ShopifySyncContext,
    order: ShopifyOrder,
  ): Promise<ShopifyOrder> {
    const lineItems = await this.loadRemainingOrderLineItems(
      input,
      order.id,
      order.lineItems.nodes,
      order.lineItems.pageInfo,
    );

    const refunds: ShopifyRefund[] = [];
    for (const refund of order.refunds) {
      const refundLineItems = await this.loadRemainingRefundLineItems(
        input,
        refund.id,
        refund.refundLineItems.nodes,
        refund.refundLineItems.pageInfo,
      );
      refunds.push({
        ...refund,
        refundLineItems,
      });
    }

    return {
      ...order,
      lineItems,
      refunds,
    };
  }

  private async loadRemainingOrderLineItems(
    input: ShopifySyncContext,
    orderId: string,
    initial: ShopifyOrderLineItem[],
    initialPageInfo: PageInfo,
  ): Promise<{ nodes: ShopifyOrderLineItem[]; pageInfo: PageInfo }> {
    if (!initialPageInfo.hasNextPage) {
      return { nodes: initial, pageInfo: initialPageInfo };
    }

    const nodes = [...initial];
    let pageInfo = initialPageInfo;

    while (pageInfo.hasNextPage) {
      const after = this.requireNextCursor(pageInfo, 'order line items');
      const data = await this.apiService.requestAdminGraphql<ShopifyOrderLineItemsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: ORDER_LINE_ITEMS_QUERY,
        variables: {
          orderId,
          first: DETAIL_PAGE_SIZE,
          after,
        },
      });

      if (!data.order) {
        throw new AppError(
          'Shopify order disappeared during line-item backfill',
          502,
          'SHOPIFY_ORDER_INCONSISTENT',
        );
      }

      const parsed = shopifyOrderLineItemConnectionSchema.safeParse(data.order.lineItems);
      if (!parsed.success) {
        throw new AppError(
          'Shopify order line-items query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }

      nodes.push(...parsed.data.nodes);
      pageInfo = parsed.data.pageInfo;

      await this.integrationService.recordExternalPayload({
        provider: 'SHOPIFY',
        resourceType: 'OrderLineItemsPage',
        externalId: orderId,
        apiVersion: input.apiVersion,
        payload: parsed.data,
        syncRunId: input.syncRunId,
      });
    }

    return { nodes, pageInfo };
  }

  private async loadRemainingRefundLineItems(
    input: ShopifySyncContext,
    refundId: string,
    initial: ShopifyRefundLineItem[],
    initialPageInfo: PageInfo,
  ): Promise<{ nodes: ShopifyRefundLineItem[]; pageInfo: PageInfo }> {
    if (!initialPageInfo.hasNextPage) {
      return { nodes: initial, pageInfo: initialPageInfo };
    }

    const nodes = [...initial];
    let pageInfo = initialPageInfo;

    while (pageInfo.hasNextPage) {
      const after = this.requireNextCursor(pageInfo, 'refund line items');
      const data = await this.apiService.requestAdminGraphql<ShopifyRefundLineItemsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: REFUND_LINE_ITEMS_QUERY,
        variables: {
          refundId,
          first: DETAIL_PAGE_SIZE,
          after,
        },
      });

      if (!data.refund) {
        throw new AppError(
          'Shopify refund disappeared during refund-line backfill',
          502,
          'SHOPIFY_ORDER_INCONSISTENT',
        );
      }

      const parsed = shopifyRefundLineItemConnectionSchema.safeParse(data.refund.refundLineItems);
      if (!parsed.success) {
        throw new AppError(
          'Shopify refund line-items query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }

      nodes.push(...parsed.data.nodes);
      pageInfo = parsed.data.pageInfo;

      await this.integrationService.recordExternalPayload({
        provider: 'SHOPIFY',
        resourceType: 'RefundLineItemsPage',
        externalId: refundId,
        apiVersion: input.apiVersion,
        payload: parsed.data,
        syncRunId: input.syncRunId,
      });
    }

    return { nodes, pageInfo };
  }

  private requireNextCursor(pageInfo: PageInfo, resource: string): string {
    if (!pageInfo.endCursor) {
      throw new AppError(
        `Shopify ${resource} pagination did not provide a next cursor`,
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    return pageInfo.endCursor;
  }
}
