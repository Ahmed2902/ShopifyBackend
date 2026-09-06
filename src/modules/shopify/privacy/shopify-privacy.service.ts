import { AppError } from '../../../errors/app-error.js';
import { normalizeShopDomain } from '../shopify.utils.js';
import { ShopifyPrivacyRepository } from './shopify-privacy.repository.js';
import {
  isShopifyComplianceTopic,
  shopifyCustomerDataRequestInboxSchema,
  shopifyCustomerDataRequestSchema,
  shopifyCustomerRedactInboxSchema,
  shopifyCustomerRedactSchema,
  shopifyExternalOrderId,
  shopifyShopRedactInboxSchema,
  shopifyShopRedactSchema,
  type ShopifyComplianceTopic,
} from './shopify-privacy.schema.js';

export type ShopifyComplianceInboxPayload = Record<string, unknown>;
type LocalShop = { id: string; myshopifyDomain: string };

function isProcessedComplianceAudit(payload: unknown, topic: ShopifyComplianceTopic): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  return record.processed === true && record.complianceTopic === topic;
}

export class ShopifyPrivacyService {
  constructor(private readonly repository: ShopifyPrivacyRepository = new ShopifyPrivacyRepository()) {}

  sanitizeForInbox(topic: string, payload: unknown): unknown {
    if (!isShopifyComplianceTopic(topic)) return payload;

    if (topic === 'customers/data_request') {
      const parsed = shopifyCustomerDataRequestSchema.parse(payload);
      return {
        shop_id: String(parsed.shop_id),
        shop_domain: normalizeShopDomain(parsed.shop_domain),
        orders_requested: parsed.orders_requested.map(shopifyExternalOrderId),
        data_request_id: parsed.data_request ? String(parsed.data_request.id) : null,
      } satisfies ShopifyComplianceInboxPayload;
    }

    if (topic === 'customers/redact') {
      const parsed = shopifyCustomerRedactSchema.parse(payload);
      return {
        shop_id: String(parsed.shop_id),
        shop_domain: normalizeShopDomain(parsed.shop_domain),
        orders_to_redact: parsed.orders_to_redact.map(shopifyExternalOrderId),
      } satisfies ShopifyComplianceInboxPayload;
    }

    const parsed = shopifyShopRedactSchema.parse(payload);
    return {
      shop_id: String(parsed.shop_id),
      shop_domain: normalizeShopDomain(parsed.shop_domain),
    } satisfies ShopifyComplianceInboxPayload;
  }

  async process(
    deliveryId: string,
    topic: ShopifyComplianceTopic,
    payload: unknown,
    localShop: LocalShop | null,
  ): Promise<void> {
    // Destructive work and the webhook status transition are intentionally separate durable
    // operations. If the process dies after the erasure transaction commits but before the worker
    // marks the delivery PROCESSED, the scrubbed payload becomes this completion marker. A stale
    // retry therefore finishes safely without attempting to parse or repeat the original request.
    if (isProcessedComplianceAudit(payload, topic)) return;

    if (!localShop) {
      // The tenant may already have been erased by an earlier delivery/retry. The request is
      // authenticated by Shopify HMAC before it reaches this point, so a missing local tenant is
      // an idempotent no-op rather than a retry loop.
      await this.repository.scrubDeliveryPayload(deliveryId, topic, { localStoreFound: false });
      return;
    }

    if (topic === 'customers/data_request') {
      const parsed = shopifyCustomerDataRequestInboxSchema.parse(payload);
      this.assertShopIdentity(parsed.shop_domain, localShop.myshopifyDomain);
      const request = await this.repository.createDataRequestExport(
        localShop.id,
        deliveryId,
        parsed.orders_requested,
      );
      await this.repository.scrubDeliveryPayload(deliveryId, topic, {
        localStoreFound: true,
        dataRequestId: request.id,
        requestedOrderCount: parsed.orders_requested.length,
      });
      return;
    }

    if (topic === 'customers/redact') {
      const parsed = shopifyCustomerRedactInboxSchema.parse(payload);
      this.assertShopIdentity(parsed.shop_domain, localShop.myshopifyDomain);
      await this.repository.redactCustomerOrders(
        localShop.id,
        deliveryId,
        parsed.orders_to_redact,
      );
      return;
    }

    const parsed = shopifyShopRedactInboxSchema.parse(payload);
    this.assertShopIdentity(parsed.shop_domain, localShop.myshopifyDomain);
    const deleted = await this.repository.purgeStore(localShop.id, deliveryId);
    if (!deleted) {
      throw new AppError('Shopify store was not found for redaction', 404, 'STORE_NOT_FOUND');
    }
  }

  listDataRequests(storeId: string) {
    return this.repository.listDataRequests(storeId);
  }

  async getDataRequest(storeId: string, requestId: string) {
    const request = await this.repository.getDataRequest(storeId, requestId);
    if (!request) {
      throw new AppError('Shopify data request was not found', 404, 'SHOPIFY_DATA_REQUEST_NOT_FOUND');
    }
    return request;
  }

  private assertShopIdentity(payloadDomain: string, expectedDomain: string): void {
    if (normalizeShopDomain(payloadDomain) !== normalizeShopDomain(expectedDomain)) {
      throw new AppError(
        'Shopify privacy webhook shop identity does not match the authenticated delivery',
        401,
        'SHOPIFY_PRIVACY_SHOP_MISMATCH',
      );
    }
  }
}

export const shopifyPrivacyService = new ShopifyPrivacyService();
