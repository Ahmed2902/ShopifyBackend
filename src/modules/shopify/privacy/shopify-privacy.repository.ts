import { prisma } from '../../../lib/prisma.js';
import { ShopifyPrivacyAccessRepository } from './shopify-privacy-access.repository.js';
import { ShopifyPrivacyPurgeRepository } from './shopify-privacy-purge.repository.js';
import { ShopifyPrivacyRedactionRepository } from './shopify-privacy-redaction.repository.js';
import { jsonValue } from './shopify-privacy.repository-utils.js';

export class ShopifyPrivacyRepository {
  constructor(
    private readonly access = new ShopifyPrivacyAccessRepository(),
    private readonly redaction = new ShopifyPrivacyRedactionRepository(),
    private readonly purge = new ShopifyPrivacyPurgeRepository(),
  ) {}

  createDataRequestExport(storeId: string, webhookDeliveryId: string, requestedOrderIds: string[]) {
    return this.access.createDataRequestExport(storeId, webhookDeliveryId, requestedOrderIds);
  }

  listDataRequests(storeId: string) {
    return this.access.listDataRequests(storeId);
  }

  getDataRequest(storeId: string, requestId: string) {
    return this.access.getDataRequest(storeId, requestId);
  }

  scrubDeliveryPayload(deliveryId: string, topic: string, summary: Record<string, unknown>) {
    return prisma.webhookDelivery.update({
      where: { id: deliveryId },
      data: {
        payload: jsonValue({
          complianceTopic: topic,
          processed: true,
          ...summary,
        }),
      },
    });
  }

  redactCustomerOrders(storeId: string, deliveryId: string, orderExternalIds: string[]) {
    return this.redaction.redactCustomerOrders(storeId, deliveryId, orderExternalIds);
  }

  purgeStore(storeId: string, currentDeliveryId: string) {
    return this.purge.purgeStore(storeId, currentDeliveryId);
  }
}
