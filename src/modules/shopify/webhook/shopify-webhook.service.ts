import { AppError } from '../../../errors/app-error.js';
import { invalidateStoreDecisionCaches } from '../../../lib/store-decision-cache.js';
import type { IntegrationService } from '../../integrations/integration.service.js';
import { toErrorMessage } from '../../integrations/integration.utils.js';
import type { ShopifyCatalogService } from '../catalog/shopify-catalog.service.js';
import type { ShopifyInventoryService } from '../inventory/shopify-inventory.service.js';
import type { ShopifyOrderService } from '../order/shopify-order.service.js';
import { isShopifyComplianceTopic } from '../privacy/shopify-privacy.schema.js';
import { ShopifyPrivacyService } from '../privacy/shopify-privacy.service.js';
import type { ShopifyAuthService } from '../shared/shopify-auth.service.js';
import type { ShopifyRequestContext, ShopifySyncContext } from '../shopify.types.js';
import { normalizeShopDomain } from '../shopify.utils.js';
import type { ShopifyWebhookRepository } from './shopify-webhook.repository.js';
import {
  shopifyBulkOperationWebhookSchema,
  shopifyInventoryLevelWebhookSchema,
  shopifyRefundWebhookSchema,
  shopifyResourceWebhookSchema,
  shopifyWebhookHeadersSchema,
} from './shopify-webhook.schema.js';
import {
  parseShopifyWebhookJson,
  shopifyGid,
  verifyShopifyWebhookHmac,
} from './shopify-webhook.utils.js';

const STALE_PROCESSING_MS = 15 * 60_000;

export class ShopifyWebhookService {
  constructor(
    private readonly repository: ShopifyWebhookRepository,
    private readonly integrationService: IntegrationService,
    private readonly authService: ShopifyAuthService,
    private readonly catalogService: ShopifyCatalogService,
    private readonly inventoryService: ShopifyInventoryService,
    private readonly orderService: ShopifyOrderService,
    private readonly privacyService: ShopifyPrivacyService = new ShopifyPrivacyService(),
  ) {}

  async receive(
    headersInput: {
      hmac?: string;
      topic?: string;
      shopDomain?: string;
      webhookId?: string;
      apiVersion?: string;
      triggeredAt?: string;
    },
    rawBody: Buffer | undefined,
  ) {
    if (!rawBody) {
      throw new AppError(
        'Shopify webhook raw body is unavailable',
        400,
        'INVALID_SHOPIFY_WEBHOOK_BODY',
      );
    }

    const headers = shopifyWebhookHeadersSchema.parse(headersInput);
    verifyShopifyWebhookHmac(rawBody, headers.hmac);
    const shopDomain = normalizeShopDomain(headers.shopDomain);
    const topic = headers.topic.toLowerCase();
    const parsedPayload = parseShopifyWebhookJson(rawBody);
    const payload = this.privacyService.sanitizeForInbox(topic, parsedPayload);
    const connection = await this.repository.findConnectionByShopDomain(shopDomain);
    const result = await this.repository.createDelivery({
      externalDeliveryId: headers.webhookId,
      shopifyConnectionId: connection?.id ?? null,
      topic,
      apiVersion: headers.apiVersion ?? connection?.apiVersion ?? null,
      triggeredAt: headers.triggeredAt ? new Date(headers.triggeredAt) : null,
      payload,
    });

    return {
      deliveryId: result.delivery.id,
      duplicate: result.duplicate,
      queued: !result.duplicate,
    };
  }

  async processDueDeliveries(limit = 20): Promise<{ claimed: number; processed: number }> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STALE_PROCESSING_MS);
    const ids = await this.repository.listDueDeliveryIds(limit, now, staleBefore);
    let claimed = 0;
    let processed = 0;

    for (const id of ids) {
      if (!(await this.repository.tryClaim(id, new Date(), staleBefore))) continue;
      claimed += 1;

      try {
        await this.processClaimedDelivery(id);
        processed += 1;
      } catch (error) {
        const delivery = await this.repository.getDelivery(id);
        await this.repository.markFailed(id, delivery?.attempts ?? 1, toErrorMessage(error));
      }
    }

    return { claimed, processed };
  }

  private async processClaimedDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.repository.getDelivery(deliveryId);
    if (!delivery) return;

    const connection = delivery.shopifyConnectionId
      ? await this.repository.findConnectionById(delivery.shopifyConnectionId)
      : null;
    const storeId = connection?.store.id ?? null;

    if (isShopifyComplianceTopic(delivery.topic)) {
      await this.privacyService.process(
        delivery.id,
        delivery.topic,
        delivery.payload,
        connection?.store ?? null,
      );
      await this.repository.markProcessed(delivery.id);
      if (storeId && delivery.topic !== 'customers/data_request') {
        await invalidateStoreDecisionCaches(storeId);
      }
      return;
    }

    if (!delivery.shopifyConnectionId) {
      await this.repository.markIgnored(delivery.id, 'Shopify connection was not found');
      return;
    }

    if (!connection) {
      await this.repository.markIgnored(delivery.id, 'Shopify connection no longer exists');
      return;
    }

    if (delivery.topic === 'app/uninstalled') {
      await this.repository.markStoreUninstalled(connection.id, connection.store.id);
      await this.repository.markProcessed(delivery.id);
      await invalidateStoreDecisionCaches(connection.store.id);
      return;
    }

    if (connection.status !== 'ACTIVE') {
      await this.repository.markIgnored(
        delivery.id,
        `Shopify connection is ${connection.status.toLowerCase()}`,
      );
      return;
    }

    const accessToken = await this.authService.resolveAccessToken(
      connection.store.myshopifyDomain,
      connection,
    );
    const context: ShopifyRequestContext = {
      storeId: connection.store.id,
      shop: connection.store.myshopifyDomain,
      accessToken,
      connectionId: connection.id,
      apiVersion: connection.apiVersion,
    };

    const handled = await this.dispatch(delivery.id, delivery.topic, delivery.payload, context);
    if (handled) {
      await this.repository.markProcessed(delivery.id);
      if (delivery.topic !== 'bulk_operations/finish') {
        await invalidateStoreDecisionCaches(context.storeId);
      }
    } else {
      await this.repository.markIgnored(delivery.id, `Unsupported Shopify topic ${delivery.topic}`);
    }
  }

  private async dispatch(
    deliveryId: string,
    topic: string,
    payload: unknown,
    context: ShopifyRequestContext,
  ): Promise<boolean> {
    switch (topic) {
      case 'products/create':
      case 'products/update': {
        const resource = shopifyResourceWebhookSchema.parse(payload);
        const productId = shopifyGid('Product', resource.admin_graphql_api_id ?? resource.id);
        const reconciled = await this.catalogService.reconcileProduct(context, productId);
        if (!reconciled.found) {
          await this.repository.markProductDeleted(context.storeId, productId);
        } else {
          await this.repository.markMissingProductVariantsDeleted(
            context.storeId,
            productId,
            reconciled.variantIds,
          );
        }
        await this.catalogService.invalidatePixelResolution(context.storeId, productId);
        return true;
      }

      case 'products/delete': {
        const resource = shopifyResourceWebhookSchema.parse(payload);
        const productId = shopifyGid('Product', resource.admin_graphql_api_id ?? resource.id);
        await this.repository.markProductDeleted(context.storeId, productId);
        await this.catalogService.invalidatePixelResolution(context.storeId, productId);
        return true;
      }

      case 'locations/create':
      case 'locations/update':
      case 'locations/activate':
      case 'locations/deactivate': {
        const resource = shopifyResourceWebhookSchema.parse(payload);
        const locationId = shopifyGid('Location', resource.admin_graphql_api_id ?? resource.id);
        const reconciled = await this.inventoryService.reconcileLocation(context, locationId);
        if (!reconciled.found) {
          await this.repository.markLocationDeleted(context.storeId, locationId);
        }
        return true;
      }

      case 'locations/delete': {
        const resource = shopifyResourceWebhookSchema.parse(payload);
        const locationId = shopifyGid('Location', resource.admin_graphql_api_id ?? resource.id);
        await this.repository.markLocationDeleted(context.storeId, locationId);
        return true;
      }

      case 'inventory_levels/connect':
      case 'inventory_levels/update': {
        const inventory = shopifyInventoryLevelWebhookSchema.parse(payload);
        const inventoryItemId = shopifyGid('InventoryItem', inventory.inventory_item_id);
        const locationId = shopifyGid('Location', inventory.location_id);
        const reconciled = await this.inventoryService.reconcileInventoryLevel(
          context,
          inventoryItemId,
          locationId,
        );
        if (!reconciled.found) {
          await this.repository.deleteInventoryLevel(
            context.storeId,
            inventoryItemId,
            locationId,
          );
        }
        return true;
      }

      case 'inventory_levels/disconnect': {
        const inventory = shopifyInventoryLevelWebhookSchema.parse(payload);
        await this.repository.deleteInventoryLevel(
          context.storeId,
          shopifyGid('InventoryItem', inventory.inventory_item_id),
          shopifyGid('Location', inventory.location_id),
        );
        return true;
      }

      case 'orders/create':
      case 'orders/updated': {
        const resource = shopifyResourceWebhookSchema.parse(payload);
        const orderId = shopifyGid('Order', resource.admin_graphql_api_id ?? resource.id);
        await this.orderService.reconcileOrder(context, orderId);
        return true;
      }

      case 'orders/cancelled': {
        const resource = shopifyResourceWebhookSchema.parse(payload);
        const orderId = shopifyGid('Order', resource.admin_graphql_api_id ?? resource.id);
        await this.orderService.reconcileOrder(context, orderId);
        return true;
      }

      case 'refunds/create': {
        const refund = shopifyRefundWebhookSchema.parse(payload);
        await this.orderService.reconcileRefund(
          context,
          shopifyGid('Refund', refund.admin_graphql_api_id ?? refund.id),
          refund.order_id ? shopifyGid('Order', refund.order_id) : null,
        );
        return true;
      }

      case 'bulk_operations/finish': {
        const bulk = shopifyBulkOperationWebhookSchema.parse(payload);
        await this.integrationService.completeShopifyBulkOperation(
          context.storeId,
          context.connectionId,
          bulk.admin_graphql_api_id,
        );
        return true;
      }

      default:
        return false;
    }
  }
}
