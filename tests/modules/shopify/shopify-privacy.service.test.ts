import { describe, expect, it, vi } from 'vitest';
import type { ShopifyPrivacyRepository } from '../../../src/modules/shopify/privacy/shopify-privacy.repository.js';
import { ShopifyPrivacyService } from '../../../src/modules/shopify/privacy/shopify-privacy.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const deliveryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function buildService() {
  const repository = {
    createDataRequestExport: vi.fn().mockResolvedValue({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    listDataRequests: vi.fn().mockResolvedValue([]),
    getDataRequest: vi.fn().mockResolvedValue(null),
    scrubDeliveryPayload: vi.fn().mockResolvedValue(undefined),
    redactCustomerOrders: vi.fn().mockResolvedValue({
      ordersDeleted: 1,
      sessionsDeleted: 1,
      eventsDeleted: 3,
    }),
    purgeStore: vi.fn().mockResolvedValue(true),
  } as unknown as ShopifyPrivacyRepository;

  return { repository, service: new ShopifyPrivacyService(repository) };
}

const localShop = { id: storeId, myshopifyDomain: 'example-store.myshopify.com' };

describe('ShopifyPrivacyService', () => {
  it('drops customer identifiers before a compliance payload reaches durable storage', () => {
    const { service } = buildService();

    const sanitized = service.sanitizeForInbox('customers/data_request', {
      shop_id: 123,
      shop_domain: 'example-store.myshopify.com',
      customer: {
        id: 456,
        email: 'private@example.com',
        phone: '+15551234567',
      },
      orders_requested: [789],
      data_request: { id: 999 },
    });

    expect(sanitized).toEqual({
      shop_id: '123',
      shop_domain: 'example-store.myshopify.com',
      orders_requested: ['gid://shopify/Order/789'],
      data_request_id: '999',
    });
    expect(JSON.stringify(sanitized)).not.toContain('private@example.com');
    expect(JSON.stringify(sanitized)).not.toContain('+15551234567');
    expect(JSON.stringify(sanitized)).not.toContain('456');
  });

  it('creates a merchant-visible export from only the sanitized order identifiers', async () => {
    const { repository, service } = buildService();
    const payload = service.sanitizeForInbox('customers/data_request', {
      shop_id: 123,
      shop_domain: 'example-store.myshopify.com',
      customer: { id: 456, email: 'private@example.com' },
      orders_requested: [789],
    });

    await service.process(deliveryId, 'customers/data_request', payload, localShop);

    expect(repository.createDataRequestExport).toHaveBeenCalledWith(
      storeId,
      deliveryId,
      ['gid://shopify/Order/789'],
    );
    expect(repository.scrubDeliveryPayload).toHaveBeenCalledWith(
      deliveryId,
      'customers/data_request',
      expect.objectContaining({ localStoreFound: true, requestedOrderCount: 1 }),
    );
  });

  it('redacts customer-linked order and journey evidence without requiring provider access', async () => {
    const { repository, service } = buildService();
    const payload = service.sanitizeForInbox('customers/redact', {
      shop_id: 123,
      shop_domain: 'example-store.myshopify.com',
      customer: { id: 456, email: 'private@example.com', phone: '+15551234567' },
      orders_to_redact: [789],
    });

    await service.process(deliveryId, 'customers/redact', payload, localShop);

    expect(repository.redactCustomerOrders).toHaveBeenCalledWith(
      storeId,
      deliveryId,
      ['gid://shopify/Order/789'],
    );
  });

  it('purges the whole tenant graph for shop/redact', async () => {
    const { repository, service } = buildService();
    const payload = service.sanitizeForInbox('shop/redact', {
      shop_id: 123,
      shop_domain: 'example-store.myshopify.com',
    });

    await service.process(deliveryId, 'shop/redact', payload, localShop);

    expect(repository.purgeStore).toHaveBeenCalledWith(storeId, deliveryId);
  });

  it('fails closed when the payload shop identity disagrees with the authenticated connection', async () => {
    const { repository, service } = buildService();
    const payload = service.sanitizeForInbox('customers/redact', {
      shop_id: 123,
      shop_domain: 'another-store.myshopify.com',
      customer: { id: 456 },
      orders_to_redact: [789],
    });

    await expect(
      service.process(deliveryId, 'customers/redact', payload, localShop),
    ).rejects.toMatchObject({
      statusCode: 401,
      code: 'SHOPIFY_PRIVACY_SHOP_MISMATCH',
    });
    expect(repository.redactCustomerOrders).not.toHaveBeenCalled();
  });

  it('treats an already-erased local tenant as an idempotent compliance no-op', async () => {
    const { repository, service } = buildService();

    await service.process(
      deliveryId,
      'shop/redact',
      { shop_id: '123', shop_domain: 'example-store.myshopify.com' },
      null,
    );

    expect(repository.scrubDeliveryPayload).toHaveBeenCalledWith(
      deliveryId,
      'shop/redact',
      { localStoreFound: false },
    );
    expect(repository.purgeStore).not.toHaveBeenCalled();
  });

  it('treats a scrubbed completion audit as a replay-safe no-op', async () => {
    const { repository, service } = buildService();

    await service.process(
      deliveryId,
      'customers/redact',
      { complianceTopic: 'customers/redact', processed: true, ordersDeleted: 1 },
      localShop,
    );

    expect(repository.redactCustomerOrders).not.toHaveBeenCalled();
    expect(repository.scrubDeliveryPayload).not.toHaveBeenCalled();
  });
});
