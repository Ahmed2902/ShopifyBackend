import { prisma } from '../../../lib/prisma.js';
import {
  findMatchingOrderWebhookDeliveries,
  jsonValue,
  PRIVACY_TRANSACTION_OPTIONS,
  uniqueStrings,
} from './shopify-privacy.repository-utils.js';

export class ShopifyPrivacyRedactionRepository {
  async redactCustomerOrders(
    storeId: string,
    deliveryId: string,
    orderExternalIds: string[],
  ): Promise<{
    ordersDeleted: number;
    sessionsDeleted: number;
    eventsDeleted: number;
  }> {
    return prisma.$transaction(
      async (tx) => {
        if (orderExternalIds.length > 0) {
          await tx.shopifyOrderRedaction.createMany({
            data: orderExternalIds.map((shopifyOrderId) => ({
              storeId,
              shopifyOrderId,
              sourceWebhookDeliveryId: deliveryId,
            })),
            skipDuplicates: true,
          });
        }

        const orders = await tx.order.findMany({
          where: { storeId, shopifyOrderId: { in: orderExternalIds } },
          select: { id: true },
        });
        const orderIds = orders.map((order) => order.id);

        const rawOrderEvents = await tx.storefrontEvent.findMany({
          where: { storeId, shopifyOrderExternalId: { in: orderExternalIds } },
          select: { sessionId: true },
        });
        const rawBrowserSessionIds = uniqueStrings(rawOrderEvents.map((event) => event.sessionId));

        const sessions = await tx.storefrontSession.findMany({
          where: {
            storeId,
            OR: [
              { shopifyOrderExternalId: { in: orderExternalIds } },
              ...(orderIds.length > 0 ? [{ orderId: { in: orderIds } }] : []),
              ...(rawBrowserSessionIds.length > 0
                ? [{ browserSessionId: { in: rawBrowserSessionIds } }]
                : []),
            ],
          },
          select: { id: true, browserSessionId: true },
        });
        const sessionIds = sessions.map((session) => session.id);
        const browserSessionIds = uniqueStrings([
          ...rawBrowserSessionIds,
          ...sessions.map((session) => session.browserSessionId),
        ]);

        const events = await tx.storefrontEvent.deleteMany({
          where: {
            storeId,
            OR: [
              { shopifyOrderExternalId: { in: orderExternalIds } },
              ...(browserSessionIds.length > 0 ? [{ sessionId: { in: browserSessionIds } }] : []),
            ],
          },
        });
        if (browserSessionIds.length > 0) {
          await tx.storefrontSessionRepair.deleteMany({
            where: { storeId, browserSessionId: { in: browserSessionIds } },
          });
        }
        const deletedSessions = await tx.storefrontSession.deleteMany({
          where: { id: { in: sessionIds }, storeId },
        });

        await tx.shopifyDataRequest.deleteMany({
          where: {
            storeId,
            requestedOrderIds: { hasSome: orderExternalIds },
          },
        });

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
          await tx.order.deleteMany({ where: { id: { in: orderIds }, storeId } });
        }

        const historicalDeliveries = await findMatchingOrderWebhookDeliveries(
          tx,
          storeId,
          orderExternalIds,
        );
        const historicalDeliveryIds = historicalDeliveries.map((item) => item.id);
        if (historicalDeliveryIds.length > 0) {
          await tx.webhookDelivery.updateMany({
            where: { id: { in: historicalDeliveryIds } },
            data: {
              payload: jsonValue({
                redacted: true,
                reason: 'customers/redact',
              }),
            },
          });
        }

        await tx.webhookDelivery.update({
          where: { id: deliveryId },
          data: {
            payload: {
              complianceTopic: 'customers/redact',
              processed: true,
              ordersDeleted: orderIds.length,
              sessionsDeleted: deletedSessions.count,
              eventsDeleted: events.count,
              webhookPayloadsScrubbed: historicalDeliveryIds.length,
            },
          },
        });

        return {
          ordersDeleted: orderIds.length,
          sessionsDeleted: deletedSessions.count,
          eventsDeleted: events.count,
        };
      },
      PRIVACY_TRANSACTION_OPTIONS,
    );
  }
}
