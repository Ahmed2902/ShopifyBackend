import { prisma } from '../../../lib/prisma.js';
import {
  findMatchingOrderWebhookDeliveries,
  jsonValue,
  PRIVACY_TRANSACTION_OPTIONS,
  uniqueStrings,
} from './shopify-privacy.repository-utils.js';

export class ShopifyPrivacyAccessRepository {
  async createDataRequestExport(
    storeId: string,
    webhookDeliveryId: string,
    requestedOrderIds: string[],
  ) {
    return prisma.$transaction(async (tx) => {
      // Serialize creation of the export with redaction/lifecycle changes. A redaction that
      // follows this read also erases its export; a stale read cannot repopulate erased data.
      await tx.$queryRaw`SELECT "storeId" FROM "ShopifyConnection" WHERE "storeId" = ${storeId}::uuid FOR SHARE`;
      const orders = await tx.order.findMany({
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

      const directlyLinkedEvents = await tx.storefrontEvent.findMany({
        where: { storeId, shopifyOrderExternalId: { in: requestedOrderIds } },
        select: { sessionId: true },
      });
      const rawBrowserSessionIds = uniqueStrings(
        directlyLinkedEvents.map((event) => event.sessionId),
      );

      const sessions = await tx.storefrontSession.findMany({
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
        tx.storefrontEvent.findMany({
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
          ? tx.storefrontSessionRepair.findMany({
              where: { storeId, browserSessionId: { in: browserSessionIds } },
              orderBy: { sourceReceivedAt: 'asc' },
            })
          : [],
        tx.shopifyOrderRedaction.findMany({
          where: { storeId, shopifyOrderId: { in: requestedOrderIds } },
          orderBy: { redactedAt: 'asc' },
        }),
        findMatchingOrderWebhookDeliveries(tx, storeId, requestedOrderIds),
      ]);

      const withdrawalKeys = [
        ...new Set([
          ...browserSessionIds.map((id) => `session:${id}`),
          ...events.flatMap((event) =>
            event.anonymousVisitorId ? [`visitor:${event.anonymousVisitorId}`] : [],
          ),
          ...sessions.flatMap((session) =>
            session.anonymousVisitorId ? [`visitor:${session.anonymousVisitorId}`] : [],
          ),
        ]),
      ];
      const consentWithdrawals =
        withdrawalKeys.length > 0
          ? await tx.storefrontConsentWithdrawal.findMany({
              where: { storeId, scopeKey: { in: withdrawalKeys } },
              orderBy: { scopeKey: 'asc' },
            })
          : [];

      const [customerLinks, conversionDeliveries] = await Promise.all([
        tx.storefrontCustomerLink.findMany({
          where: { storeId, sourceOrderId: { in: orderDbIds } },
          orderBy: [{ createdAt: 'asc' }, { sourceOrderId: 'asc' }],
        }),
        tx.conversionDelivery.findMany({
          where: {
            storeId,
            OR: [
              { shopifyOrderId: { in: requestedOrderIds } },
              { sourceOrderId: { in: orderDbIds } },
              { sourceEventId: { in: events.map((event) => event.id) } },
            ],
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      ]);

      const exportJson = jsonValue({
        generatedAt: new Date().toISOString(),
        disclosure: {
          customerProfileFieldsStored: false,
          source:
            'All retained Metrico records linked to the Shopify order identifiers supplied by the privacy request',
        },
        requestedOrderIds,
        orders,
        storefrontSessions: sessions,
        storefrontEvents: events,
        storefrontConsentWithdrawals: consentWithdrawals,
        storefrontCustomerLinks: customerLinks,
        conversionDeliveries,
        storefrontSessionRepairs: repairs,
        orderRedactionTombstones: redactions,
        historicalShopifyWebhookDeliveries: webhookDeliveries,
      });

      return tx.shopifyDataRequest.upsert({
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
    }, PRIVACY_TRANSACTION_OPTIONS);
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
