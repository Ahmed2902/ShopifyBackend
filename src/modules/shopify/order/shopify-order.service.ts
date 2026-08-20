import { AppError } from '../../../errors/app-error.js';
import type { ShopifyApiService } from '../shared/shopify-api.service.js';
import type { ShopifyBulkService } from '../bulk/shopify-bulk.service.js';
import type { ShopifyRequestContext, ShopifySyncContext } from '../shopify.types.js';
import {
  ORDER_DETAILS_QUERY,
  ORDER_HISTORY_BULK_QUERY,
  REFUND_DETAILS_QUERY,
} from './shopify-order.queries.js';
import type { ShopifyOrderRepository } from './shopify-order.repository.js';
import {
  shopifyBulkOrderLineItemSchema,
  shopifyOrderDetailsSchema,
  shopifyOrderHeaderSchema,
  shopifyRefundQuerySchema,
  type ShopifyOrderHeader,
  type ShopifyRefund,
} from './shopify-order.schema.js';
import type {
  ShopifyImportedOrder,
  ShopifyOrderBackfillInspection,
  ShopifyOrderBackfillResult,
  ShopifyOrderQueryData,
  ShopifyRefundQueryData,
} from './shopify-order.types.js';

const DETAIL_PAGE_SIZE = 250;

export class ShopifyOrderService {
  constructor(
    private readonly repository: ShopifyOrderRepository,
    private readonly apiService: ShopifyApiService,
    private readonly bulkService: ShopifyBulkService,
  ) {}

  startBulkBackfill(input: ShopifySyncContext) {
    return this.bulkService.startQuery(input, ORDER_HISTORY_BULK_QUERY);
  }

  async inspectBulkBackfill(
    input: ShopifySyncContext,
    operationId: string,
  ): Promise<ShopifyOrderBackfillInspection> {
    const operation = await this.bulkService.getStatus(input, operationId);
    const providerStatus = operation.status.toUpperCase();

    if (['CREATED', 'RUNNING', 'CANCELING'].includes(providerStatus)) {
      return {
        state: 'RUNNING',
        providerStatus,
        objectCount: operation.objectCount ?? null,
      };
    }

    if (providerStatus === 'COMPLETED') {
      const result = operation.url
        ? await this.importBulkResult(input, operation.url)
        : this.emptyResult();
      return {
        state: 'COMPLETED',
        providerStatus: 'COMPLETED',
        ...result,
      };
    }

    if (['FAILED', 'CANCELED', 'EXPIRED'].includes(providerStatus)) {
      return {
        state: 'FAILED',
        providerStatus,
        errorCode: operation.errorCode ?? null,
      };
    }

    throw new AppError(
      `Shopify returned unknown bulk-operation status ${operation.status}`,
      502,
      'SHOPIFY_BAD_RESPONSE',
    );
  }

  async reconcileOrder(
    input: ShopifyRequestContext,
    orderId: string,
  ): Promise<{ found: boolean; result?: ShopifyOrderBackfillResult }> {
    let cursor: string | null = null;
    const seenCursors = new Set<string>();
    let header: ShopifyOrderHeader | null = null;
    const lineItems: ShopifyImportedOrder['lineItems'] = [];

    while (true) {
      const data = await this.apiService.requestAdminGraphql<ShopifyOrderQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: ORDER_DETAILS_QUERY,
        variables: { id: orderId, first: DETAIL_PAGE_SIZE, after: cursor },
      });
      if (!data.order) return { found: false };

      const parsed = shopifyOrderDetailsSchema.safeParse(data.order);
      if (!parsed.success || parsed.data.id !== orderId) {
        throw new AppError(
          'Shopify order webhook reconciliation returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }

      const { lineItems: page, ...orderHeader } = parsed.data;
      header ??= orderHeader;
      lineItems.push(...page.nodes);

      if (!page.pageInfo.hasNextPage) break;
      const nextCursor = page.pageInfo.endCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new AppError(
          'Shopify order pagination returned an invalid cursor',
          502,
          'SHOPIFY_BAD_PAGINATION',
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (!header) return { found: false };
    const result = this.emptyResult();
    await this.persistOrder(input, { ...header, lineItems }, result);
    return { found: true, result };
  }

  private async importBulkResult(
    input: ShopifySyncContext,
    url: string,
  ): Promise<ShopifyOrderBackfillResult> {
    const result = this.emptyResult();
    let currentOrder: ShopifyImportedOrder | null = null;

    for await (const rawLine of this.bulkService.streamJsonl(url)) {
      const order = shopifyOrderHeaderSchema.safeParse(rawLine);
      if (order.success) {
        if (currentOrder) await this.persistOrder(input, currentOrder, result);
        currentOrder = { ...order.data, lineItems: [] };
        continue;
      }

      const lineItem = shopifyBulkOrderLineItemSchema.safeParse(rawLine);
      if (!lineItem.success) {
        throw new AppError(
          'Shopify order bulk file contained an unexpected record',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      if (!currentOrder || lineItem.data.__parentId !== currentOrder.id) {
        throw new AppError(
          'Shopify order bulk file contained an invalid parent relationship',
          502,
          'SHOPIFY_ORDER_INCONSISTENT',
        );
      }

      const { __parentId: _parentId, ...item } = lineItem.data;
      currentOrder.lineItems.push(item);
    }

    if (currentOrder) await this.persistOrder(input, currentOrder, result);
    return result;
  }

  private async persistOrder(
    input: ShopifyRequestContext,
    order: ShopifyImportedOrder,
    result: ShopifyOrderBackfillResult,
  ): Promise<void> {
    const persistedOrder = await this.repository.upsertOrderWithLineItems(input.storeId, order);
    result.breakdown.orders += 1;
    result.breakdown.lineItems += order.lineItems.length;
    result.recordsRead += 1 + order.lineItems.length;
    result.recordsWritten += 1 + order.lineItems.length;

    for (const refundHeader of order.refunds) {
      const refund = await this.loadRefund(input, refundHeader);
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

      result.breakdown.refunds += 1;
      result.breakdown.refundLineItems += refund.refundLineItems.nodes.length;
      result.recordsRead += 1 + refund.refundLineItems.nodes.length;
      result.recordsWritten += 1 + refund.refundLineItems.nodes.length;
    }
  }

  private async loadRefund(
    input: ShopifyRequestContext,
    header: ShopifyOrderHeader['refunds'][number],
  ): Promise<ShopifyRefund> {
    const nodes: ShopifyRefund['refundLineItems']['nodes'] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;
    let hydratedRefund: ShopifyRefund | null = null;

    while (true) {
      const data = await this.apiService.requestAdminGraphql<ShopifyRefundQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: REFUND_DETAILS_QUERY,
        variables: {
          refundId: header.id,
          first: DETAIL_PAGE_SIZE,
          after: cursor,
        },
      });
      const parsed = shopifyRefundQuerySchema.safeParse(data);
      if (!parsed.success || !parsed.data.refund) {
        throw new AppError(
          'Shopify refund could not be loaded during order reconciliation',
          502,
          'SHOPIFY_ORDER_INCONSISTENT',
        );
      }
      if (parsed.data.refund.id !== header.id) {
        throw new AppError(
          'Shopify returned a different refund during order reconciliation',
          502,
          'SHOPIFY_ORDER_INCONSISTENT',
        );
      }

      hydratedRefund = parsed.data.refund;
      nodes.push(...hydratedRefund.refundLineItems.nodes);
      if (!hydratedRefund.refundLineItems.pageInfo.hasNextPage) break;

      const nextCursor = hydratedRefund.refundLineItems.pageInfo.endCursor;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        throw new AppError(
          'Shopify refund pagination returned an invalid cursor',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    if (!hydratedRefund) {
      throw new AppError(
        'Shopify refund could not be loaded during order reconciliation',
        502,
        'SHOPIFY_ORDER_INCONSISTENT',
      );
    }

    return {
      ...hydratedRefund,
      refundLineItems: {
        nodes,
        pageInfo: hydratedRefund.refundLineItems.pageInfo,
      },
    };
  }

  private emptyResult(): ShopifyOrderBackfillResult {
    return {
      recordsRead: 0,
      recordsWritten: 0,
      breakdown: {
        orders: 0,
        lineItems: 0,
        refunds: 0,
        refundLineItems: 0,
      },
    };
  }
}
