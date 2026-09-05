import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

const MAX_ATTEMPTS = 5;

const connectionSelect = {
  id: true,
  status: true,
  accessTokenCiphertext: true,
  accessTokenExpiresAt: true,
  refreshTokenCiphertext: true,
  refreshTokenExpiresAt: true,
  scopes: true,
  apiVersion: true,
  store: { select: { id: true, myshopifyDomain: true } },
} as const;

export class ShopifyWebhookRepository {
  findConnectionByShopDomain(shopDomain: string) {
    return prisma.shopifyConnection.findFirst({
      where: { store: { myshopifyDomain: shopDomain } },
      select: connectionSelect,
    });
  }

  findConnectionById(connectionId: string) {
    return prisma.shopifyConnection.findUnique({
      where: { id: connectionId },
      select: connectionSelect,
    });
  }

  async createDelivery(input: {
    externalDeliveryId: string;
    shopifyConnectionId: string | null;
    topic: string;
    apiVersion: string | null;
    triggeredAt: Date | null;
    payload: unknown;
  }) {
    const key = {
      provider_externalDeliveryId: {
        provider: 'SHOPIFY' as const,
        externalDeliveryId: input.externalDeliveryId,
      },
    };
    const existing = await prisma.webhookDelivery.findUnique({ where: key });
    if (existing) return { delivery: existing, duplicate: true };

    try {
      const delivery = await prisma.webhookDelivery.create({
        data: {
          provider: 'SHOPIFY',
          externalDeliveryId: input.externalDeliveryId,
          shopifyConnectionId: input.shopifyConnectionId,
          topic: input.topic,
          apiVersion: input.apiVersion,
          triggeredAt: input.triggeredAt,
          status: 'QUEUED',
          nextAttemptAt: new Date(),
          payload: input.payload as Prisma.InputJsonValue,
        },
      });
      return { delivery, duplicate: false };
    } catch (error) {
      const raced = await prisma.webhookDelivery.findUnique({ where: key });
      if (raced) return { delivery: raced, duplicate: true };
      throw error;
    }
  }

  async listDueDeliveryIds(limit: number, now: Date, staleBefore: Date): Promise<string[]> {
    const deliveries = await prisma.webhookDelivery.findMany({
      where: {
        provider: 'SHOPIFY',
        attempts: { lt: MAX_ATTEMPTS },
        OR: [
          { status: 'QUEUED', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', processingStartedAt: { lte: staleBefore } },
        ],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { receivedAt: 'asc' }],
      select: { id: true },
      take: limit,
    });
    return deliveries.map((delivery) => delivery.id);
  }

  async tryClaim(id: string, now: Date, staleBefore: Date): Promise<boolean> {
    const result = await prisma.webhookDelivery.updateMany({
      where: {
        id,
        provider: 'SHOPIFY',
        attempts: { lt: MAX_ATTEMPTS },
        OR: [
          { status: 'QUEUED', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', processingStartedAt: { lte: staleBefore } },
        ],
      },
      data: {
        status: 'PROCESSING',
        processingStartedAt: now,
        nextAttemptAt: null,
        lastError: null,
        attempts: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  getDelivery(id: string) {
    return prisma.webhookDelivery.findUnique({
      where: { id },
      select: {
        id: true,
        topic: true,
        apiVersion: true,
        payload: true,
        attempts: true,
        shopifyConnectionId: true,
      },
    });
  }

  markProcessed(id: string) {
    return prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        processingStartedAt: null,
        nextAttemptAt: null,
        lastError: null,
      },
    });
  }

  markIgnored(id: string, reason?: string) {
    return prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'IGNORED',
        processedAt: new Date(),
        processingStartedAt: null,
        nextAttemptAt: null,
        lastError: reason ?? null,
      },
    });
  }

  markFailed(id: string, attempts: number, message: string) {
    const terminal = attempts >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
    return prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'FAILED',
        processingStartedAt: null,
        nextAttemptAt: terminal ? null : new Date(Date.now() + delaySeconds * 1000),
        lastError: message.slice(0, 4000),
      },
    });
  }

  markConnectionUninstalled(connectionId: string) {
    return prisma.shopifyConnection.update({
      where: { id: connectionId },
      data: {
        status: 'UNINSTALLED',
        uninstalledAt: new Date(),
      },
    });
  }

  markProductDeleted(storeId: string, shopifyProductId: string) {
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { storeId_shopifyProductId: { storeId, shopifyProductId } },
        select: { id: true },
      });
      if (!product) return false;

      const deletedAt = new Date();
      const variants = await tx.productVariant.findMany({
        where: { storeId, productId: product.id },
        select: { id: true },
      });
      const variantIds = variants.map((variant) => variant.id);
      if (variantIds.length > 0) {
        await tx.inventoryItem.updateMany({
          where: { storeId, variantId: { in: variantIds } },
          data: { deletedAt },
        });
        await tx.productVariant.updateMany({
          where: { id: { in: variantIds } },
          data: { deletedAt },
        });
      }
      await tx.product.update({ where: { id: product.id }, data: { deletedAt } });
      return true;
    });
  }

  markMissingProductVariantsDeleted(
    storeId: string,
    shopifyProductId: string,
    activeShopifyVariantIds: string[],
  ) {
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: { storeId_shopifyProductId: { storeId, shopifyProductId } },
        select: { id: true },
      });
      if (!product) return 0;

      const missing = await tx.productVariant.findMany({
        where: {
          storeId,
          productId: product.id,
          deletedAt: null,
          ...(activeShopifyVariantIds.length > 0
            ? { shopifyVariantId: { notIn: activeShopifyVariantIds } }
            : {}),
        },
        select: { id: true },
      });
      const ids = missing.map((variant) => variant.id);
      if (ids.length === 0) return 0;

      const deletedAt = new Date();
      await tx.inventoryItem.updateMany({
        where: { storeId, variantId: { in: ids } },
        data: { deletedAt },
      });
      await tx.productVariant.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt },
      });
      return ids.length;
    });
  }

  markLocationDeleted(storeId: string, shopifyLocationId: string) {
    return prisma.location.updateMany({
      where: { storeId, shopifyLocationId },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async deleteInventoryLevel(
    storeId: string,
    shopifyInventoryItemId: string,
    shopifyLocationId: string,
  ): Promise<boolean> {
    const [item, location] = await Promise.all([
      prisma.inventoryItem.findUnique({
        where: { storeId_shopifyInventoryItemId: { storeId, shopifyInventoryItemId } },
        select: { id: true },
      }),
      prisma.location.findUnique({
        where: { storeId_shopifyLocationId: { storeId, shopifyLocationId } },
        select: { id: true },
      }),
    ]);
    if (!item || !location) return false;

    await prisma.inventoryLevelCurrent.deleteMany({
      where: { inventoryItemId: item.id, locationId: location.id },
    });
    return true;
  }

  async deleteOrder(storeId: string, shopifyOrderId: string): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const order = await tx.order.findUnique({
        where: { storeId_shopifyOrderId: { storeId, shopifyOrderId } },
        select: { id: true },
      });
      if (!order) return false;

      const dirtyAt = new Date();
      await tx.storefrontSession.updateMany({
        where: { storeId, orderId: order.id },
        data: {
          orderId: null,
          orderLinkStatus: 'PENDING',
          orderLinkAttemptCount: 0,
          orderLinkNextAttemptAt: dirtyAt,
          rollupDirtyAt: dirtyAt,
        },
      });

      const refunds = await tx.refund.findMany({
        where: { orderId: order.id },
        select: { id: true },
      });
      const refundIds = refunds.map((refund) => refund.id);
      if (refundIds.length > 0) {
        await tx.refundLineItem.deleteMany({ where: { refundId: { in: refundIds } } });
        await tx.refund.deleteMany({ where: { id: { in: refundIds } } });
      }
      await tx.orderLineItem.deleteMany({ where: { orderId: order.id } });
      await tx.order.delete({ where: { id: order.id } });
      return true;
    });
  }

  findOrderBackfillByOperation(connectionId: string, providerOperationId: string) {
    return prisma.syncRun.findFirst({
      where: {
        provider: 'SHOPIFY',
        shopifyConnectionId: connectionId,
        resourceType: 'OrdersRefunds',
        providerOperationId,
      },
      select: {
        id: true,
        status: true,
        providerOperationId: true,
        recordsRead: true,
        recordsWritten: true,
      },
    });
  }
}
