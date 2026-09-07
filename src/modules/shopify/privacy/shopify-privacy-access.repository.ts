import { prisma } from '../../../lib/prisma.js';
import {
  findMatchingOrderWebhookDeliveries,
  jsonValue,
  uniqueStrings,
} from './shopify-privacy.repository-utils.js';

export class ShopifyPrivacyAccessRepository {
  async createDataRequestExport(
    storeId: string,
    webhookDeliveryId: string,
    requestedOrderIds: string[],
  ) {
    const orders = await prisma.order.findMany({
      where: { storeId, shopifyOrderId: { in: requestedOrderIds } },
      orderBy: { shopifyCreatedAt: 'asc' },
      include: {
        lineItems: { orderBy: { shopifyLineItemId: 'asc' } },
        refunds: {
          orderBy: { shopifyCreatedAt: 'asc' },
          include: { lineItems: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });
    const orderDbIds = orders.map((order) => order.id);

    const directlyLinkedEvents = await prisma.storefrontEvent.findMany({
      where: { storeId, shopifyOrderExternalId: { in: requestedOrderIds } },
      select: { sessionId: true },
    });
    const rawBrowserSessionIds = uniqueStrings(directlyLinkedEvents.map((event) => event.sessionId));

    const sessions = await prisma.storefrontSession.findMany({
      where: {
        storeId,
        OR: [
          { shopifyOrderExternalId: { in: requestedOrderIds } },
          ...(orderDbIds.length > 0 ? [{ orderId: { in: orderDbIds } }] : []),
          ...(rawBrowserSessionIds.length > 0
            ? [{ browserSessionId: { in: rawBrowserSessionIds } }]
            : []),
        ],
      },
      orderBy: { startedAt: 'asc' },
      include: {
        touches: { orderBy: { ordinal: 'asc' } },
        products: { orderBy: { firstSeenAt: 'asc' } },
        collections: { orderBy: { firstSeenAt: 'asc' } },
      },
    });
    const browserSessionIds = uniqueStrings([
      ...rawBrowserSessionIds,
      ...sessions.map((session) => session.browserSessionId),
    ]);

    const [events, repairs, redactions, webhookDeliveries] = await Promise.all([
      prisma.storefrontEvent.findMany({
        where: {
          storeId,
          OR: [
            { shopifyOrderExternalId: { in: requestedOrderIds } },
            ...(browserSessionIds.length > 0 ? [{ sessionId: { in: browserSessionIds } }] : []),
          ],
        },
        orderBy: [{ eventAt: 'asc' }, { receivedAt: 'asc' }],
      }),
      browserSessionIds.length > 0
        ? prisma.storefrontSessionRepair.findMany({
            where: { storeId, browserSessionId: { in: browserSessionIds } },
            orderBy: { sourceReceivedAt: 'asc' },
          })
        : [],
      prisma.shopifyOrderRedaction.findMany({
        where: { storeId, shopifyOrderId: { in: requestedOrderIds } },
        orderBy: { redactedAt: 'asc' },
      }),
      findMatchingOrderWebhookDeliveries(prisma, storeId, requestedOrderIds),
    ]);

    const exportJson = jsonValue({
      generatedAt: new Date().toISOString(),
      disclosure: {
        customerProfileFieldsStored: false,
        source:
          'All retained Stride records linked to the Shopify order identifiers supplied by the privacy request',
      },
      requestedOrderIds,
      orders,
      storefrontSessions: sessions,
      storefrontEvents: events,
      storefrontSessionRepairs: repairs,
      orderRedactionTombstones: redactions,
      historicalShopifyWebhookDeliveries: webhookDeliveries,
    });

    return prisma.shopifyDataRequest.upsert({
      where: { webhookDeliveryId },
      create: {
        storeId,
        webhookDeliveryId,
        requestedOrderIds,
        exportJson,
      },
      update: {
        requestedOrderIds,
        exportJson,
        completedAt: new Date(),
      },
      select: {
        id: true,
        requestedOrderIds: true,
        exportJson: true,
        completedAt: true,
        createdAt: true,
      },
    });
  }

  listDataRequests(storeId: string) {
    return prisma.shopifyDataRequest.findMany({
      where: { storeId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        requestedOrderIds: true,
        completedAt: true,
        createdAt: true,
      },
      take: 100,
    });
  }

  getDataRequest(storeId: string, requestId: string) {
    return prisma.shopifyDataRequest.findFirst({
      where: { id: requestId, storeId },
      select: {
        id: true,
        requestedOrderIds: true,
        exportJson: true,
        completedAt: true,
        createdAt: true,
      },
    });
  }
}
