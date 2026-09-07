import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import type { ShopifyCatalogService } from '../../../src/modules/shopify/catalog/shopify-catalog.service.js';
import type { ShopifyInventoryService } from '../../../src/modules/shopify/inventory/shopify-inventory.service.js';
import type { ShopifyOrderService } from '../../../src/modules/shopify/order/shopify-order.service.js';
import type { ShopifyPrivacyService } from '../../../src/modules/shopify/privacy/shopify-privacy.service.js';
import type { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';
import type { ShopifyWebhookRepository } from '../../../src/modules/shopify/webhook/shopify-webhook.repository.js';
import { ShopifyWebhookService } from '../../../src/modules/shopify/webhook/shopify-webhook.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const deliveryId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const connection = {
  id: connectionId,
  status: 'UNINSTALLED',
  accessTokenCiphertext: 'ciphertext',
  accessTokenExpiresAt: null,
  refreshTokenCiphertext: null,
  refreshTokenExpiresAt: null,
  scopes: ['read_orders'],
  apiVersion: '2026-07',
  store: { id: storeId, myshopifyDomain: 'example-store.myshopify.com' },
};

function sign(body: Buffer): string {
  return createHmac('sha256', process.env.SHOPIFY_CLIENT_SECRET!).update(body).digest('base64');
}

function buildService(input?: { deliveryTopic?: string; deliveryPayload?: unknown }) {
  const repository = {
    findConnectionByShopDomain: vi.fn().mockResolvedValue(connection),
    findConnectionById: vi.fn().mockResolvedValue(connection),
    createDelivery: vi.fn().mockResolvedValue({
      delivery: { id: deliveryId },
      duplicate: false,
    }),
    listDueDeliveryIds: vi.fn().mockResolvedValue([deliveryId]),
    tryClaim: vi.fn().mockResolvedValue(true),
    getDelivery: vi.fn().mockResolvedValue({
      id: deliveryId,
      topic: input?.deliveryTopic ?? 'customers/redact',
      payload: input?.deliveryPayload ?? {
        shop_id: '123',
        shop_domain: 'example-store.myshopify.com',
        orders_to_redact: ['gid://shopify/Order/789'],
      },
      attempts: 1,
      shopifyConnectionId: connectionId,
    }),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    markIgnored: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShopifyWebhookRepository;

  const privacyService = {
    sanitizeForInbox: vi.fn((topic: string, payload: unknown) => {
      if (topic !== 'customers/data_request') return payload;
      const value = payload as {
        shop_id: number;
        shop_domain: string;
        orders_requested: number[];
        data_request?: { id: number };
      };
      return {
        shop_id: String(value.shop_id),
        shop_domain: value.shop_domain,
        orders_requested: value.orders_requested.map((id) => `gid://shopify/Order/${id}`),
        data_request_id: value.data_request ? String(value.data_request.id) : null,
      };
    }),
    process: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShopifyPrivacyService;

  const authService = {
    resolveAccessToken: vi.fn().mockRejectedValue(new Error('must not be called')),
  } as unknown as ShopifyAuthService;

  const service = new ShopifyWebhookService(
    repository,
    {} as IntegrationService,
    authService,
    {} as ShopifyCatalogService,
    {} as ShopifyInventoryService,
    {} as ShopifyOrderService,
    privacyService,
  );

  return { repository, privacyService, authService, service };
}

describe('Shopify compliance webhook routing', () => {
  it('writes only the privacy service sanitized payload to the durable inbox', async () => {
    const { repository, service } = buildService();
    const raw = Buffer.from(
      JSON.stringify({
        shop_id: 123,
        shop_domain: 'example-store.myshopify.com',
        customer: {
          id: 456,
          email: 'private@example.com',
          phone: '+15551234567',
        },
        orders_requested: [789],
        data_request: { id: 999 },
      }),
    );

    await service.receive(
      {
        hmac: sign(raw),
        topic: 'customers/data_request',
        shopDomain: 'example-store.myshopify.com',
        webhookId: 'compliance-delivery-1',
        apiVersion: '2026-07',
      },
      raw,
    );

    const input = vi.mocked(repository.createDelivery).mock.calls[0]![0];
    expect(input.payload).toEqual({
      shop_id: '123',
      shop_domain: 'example-store.myshopify.com',
      orders_requested: ['gid://shopify/Order/789'],
      data_request_id: '999',
    });
    expect(JSON.stringify(input.payload)).not.toContain('private@example.com');
    expect(JSON.stringify(input.payload)).not.toContain('+15551234567');
  });

  it('processes compliance erasure even after the Shopify connection is uninstalled', async () => {
    const { repository, privacyService, authService, service } = buildService();

    const result = await service.processDueDeliveries();

    expect(result).toEqual({ claimed: 1, processed: 1 });
    expect(privacyService.process).toHaveBeenCalledWith(
      deliveryId,
      'customers/redact',
      expect.objectContaining({ orders_to_redact: ['gid://shopify/Order/789'] }),
      connection.store,
    );
    expect(authService.resolveAccessToken).not.toHaveBeenCalled();
    expect(repository.markProcessed).toHaveBeenCalledWith(deliveryId);
    expect(repository.markIgnored).not.toHaveBeenCalled();
  });

  it('treats compliance delivery without a surviving local connection as an idempotent privacy job', async () => {
    const { repository, privacyService, service } = buildService({
      deliveryTopic: 'shop/redact',
      deliveryPayload: { shop_id: '123', shop_domain: 'example-store.myshopify.com' },
    });
    vi.mocked(repository.findConnectionById).mockResolvedValue(null);

    await service.processDueDeliveries();

    expect(privacyService.process).toHaveBeenCalledWith(
      deliveryId,
      'shop/redact',
      expect.any(Object),
      null,
    );
    expect(repository.markProcessed).toHaveBeenCalledWith(deliveryId);
  });
});
