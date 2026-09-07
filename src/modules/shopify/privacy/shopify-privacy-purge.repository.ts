import { prisma } from '../../../lib/prisma.js';
import { PRIVACY_TRANSACTION_OPTIONS } from './shopify-privacy.repository-utils.js';

export class ShopifyPrivacyPurgeRepository {
  async purgeStore(storeId: string, currentDeliveryId: string): Promise<boolean> {
    return prisma.$transaction(
      async (tx) => {
        const store = await tx.store.findUnique({
          where: { id: storeId },
          select: {
            id: true,
            shopifyConnection: { select: { id: true } },
            metaConnection: { select: { id: true } },
            tiktokConnection: { select: { id: true } },
          },
        });
        if (!store) return false;

        const shopifyConnectionId = store.shopifyConnection?.id ?? null;
        const metaConnectionId = store.metaConnection?.id ?? null;
        const tiktokConnectionId = store.tiktokConnection?.id ?? null;

        const syncRuns = await tx.syncRun.findMany({
          where: {
            OR: [
              ...(shopifyConnectionId ? [{ shopifyConnectionId }] : []),
              ...(metaConnectionId ? [{ metaConnectionId }] : []),
              ...(tiktokConnectionId ? [{ tiktokConnectionId }] : []),
            ],
          },
          select: { id: true },
        });
        const syncRunIds = syncRuns.map((run) => run.id);

        const deliveries = await tx.webhookDelivery.findMany({
          where: {
            id: { not: currentDeliveryId },
            OR: [
              ...(shopifyConnectionId ? [{ shopifyConnectionId }] : []),
              ...(metaConnectionId ? [{ metaConnectionId }] : []),
              ...(tiktokConnectionId ? [{ tiktokConnectionId }] : []),
            ],
          },
          select: { id: true },
        });
        const deliveryIds = deliveries.map((delivery) => delivery.id);

        await tx.externalPayload.deleteMany({
          where: {
            OR: [
              ...(syncRunIds.length > 0 ? [{ syncRunId: { in: syncRunIds } }] : []),
              ...(deliveryIds.length > 0 ? [{ webhookDeliveryId: { in: deliveryIds } }] : []),
              { webhookDeliveryId: currentDeliveryId },
            ],
          },
        });

        await tx.shopifyDataRequest.deleteMany({ where: { storeId } });
        if (deliveryIds.length > 0) {
          await tx.webhookDelivery.deleteMany({ where: { id: { in: deliveryIds } } });
        }
        if (syncRunIds.length > 0) {
          await tx.syncRun.deleteMany({ where: { id: { in: syncRunIds } } });
        }

        await tx.adCollectionMapping.deleteMany({
          where: {
            OR: [{ collection: { storeId } }, { ad: { adAccount: { storeId } } }],
          },
        });
        await tx.adProductMapping.deleteMany({
          where: {
            OR: [{ product: { storeId } }, { ad: { adAccount: { storeId } } }],
          },
        });
        await tx.catalogItemVariantMapping.deleteMany({
          where: {
            OR: [{ variant: { storeId } }, { catalogItem: { catalog: { storeId } } }],
          },
        });
        await tx.tikTokAdProductMapping.deleteMany({
          where: {
            OR: [{ product: { storeId } }, { ad: { advertiser: { storeId } } }],
          },
        });
        await tx.tikTokCatalogItemVariantMapping.deleteMany({
          where: {
            OR: [{ variant: { storeId } }, { catalogItem: { catalog: { storeId } } }],
          },
        });

        await tx.metaInsightDaily.deleteMany({ where: { adAccount: { storeId } } });
        await tx.metaAd.deleteMany({ where: { adAccount: { storeId } } });
        await tx.metaCreative.deleteMany({ where: { adAccount: { storeId } } });
        await tx.metaAdSet.deleteMany({ where: { adAccount: { storeId } } });
        await tx.metaCampaign.deleteMany({ where: { adAccount: { storeId } } });
        await tx.metaCatalogItem.deleteMany({ where: { catalog: { storeId } } });
        await tx.metaProductCatalog.deleteMany({ where: { storeId } });
        await tx.metaAdAccount.deleteMany({ where: { storeId } });

        await tx.tikTokInsightDaily.deleteMany({ where: { advertiser: { storeId } } });
        await tx.tikTokAd.deleteMany({ where: { advertiser: { storeId } } });
        await tx.tikTokAdGroup.deleteMany({ where: { advertiser: { storeId } } });
        await tx.tikTokCampaign.deleteMany({ where: { advertiser: { storeId } } });
        await tx.tikTokCatalogItem.deleteMany({ where: { catalog: { storeId } } });
        await tx.tikTokCatalog.deleteMany({ where: { storeId } });
        await tx.tikTokAdvertiser.deleteMany({ where: { storeId } });

        const orders = await tx.order.findMany({ where: { storeId }, select: { id: true } });
        const orderIds = orders.map((order) => order.id);
        if (orderIds.length > 0) {
          const refunds = await tx.refund.findMany({
            where: { orderId: { in: orderIds } },
            select: { id: true },
          });
          const refundIds = refunds.map((refund) => refund.id);
          if (refundIds.length > 0) {
            await tx.refundLineItem.deleteMany({ where: { refundId: { in: refundIds } } });
            await tx.refund.deleteMany({ where: { id: { in: refundIds } } });
          }
          await tx.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
          await tx.order.deleteMany({ where: { id: { in: orderIds } } });
        }

        await tx.restock.deleteMany({ where: { storeId } });
        await tx.inventoryLevelCurrent.deleteMany({ where: { inventoryItem: { storeId } } });
        await tx.inventorySnapshot.deleteMany({ where: { inventoryItem: { storeId } } });
        await tx.inventoryItem.deleteMany({ where: { storeId } });
        await tx.variantCost.deleteMany({ where: { variant: { storeId } } });
        await tx.productVariant.deleteMany({ where: { storeId } });
        await tx.product.deleteMany({ where: { storeId } });
        await tx.collection.deleteMany({ where: { storeId } });
        await tx.location.deleteMany({ where: { storeId } });

        if (metaConnectionId) await tx.metaConnection.delete({ where: { id: metaConnectionId } });
        if (tiktokConnectionId) {
          await tx.tikTokConnection.delete({ where: { id: tiktokConnectionId } });
        }
        if (shopifyConnectionId) {
          await tx.shopifyConnection.delete({ where: { id: shopifyConnectionId } });
        }

        await tx.webhookDelivery.update({
          where: { id: currentDeliveryId },
          data: {
            payload: { complianceTopic: 'shop/redact', processed: true },
          },
        });

        await tx.store.delete({ where: { id: storeId } });
        return true;
      },
      PRIVACY_TRANSACTION_OPTIONS,
    );
  }
}
