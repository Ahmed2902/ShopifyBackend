import { describe, expect, it, vi } from 'vitest';
import type { ShopifyPrivacyRepository } from '../../../src/modules/shopify/privacy/shopify-privacy.repository.js';
import { ShopifyPrivacyService } from '../../../src/modules/shopify/privacy/shopify-privacy.service.js';

const deliveryId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const localShop = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  myshopifyDomain: 'example-store.myshopify.com',
};

function repository() {
  return {
    createDataRequestExport: vi.fn(),
    listDataRequests: vi.fn(),
    getDataRequest: vi.fn(),
    scrubDeliveryPayload: vi.fn(),
    redactCustomerOrders: vi.fn(),
    purgeStore: vi.fn(),
  } as unknown as ShopifyPrivacyRepository;
}

describe('Shopify privacy completion retry', () => {
  it.each([
    'customers/data_request',
    'customers/redact',
    'shop/redact',
  ] as const)('treats a scrubbed %s delivery as already committed', async (topic) => {
    const repo = repository();
    const service = new ShopifyPrivacyService(repo);

    await service.process(
      deliveryId,
      topic,
      { complianceTopic: topic, processed: true, committedBeforeCrash: true },
      localShop,
    );

    expect(repo.createDataRequestExport).not.toHaveBeenCalled();
    expect(repo.redactCustomerOrders).not.toHaveBeenCalled();
    expect(repo.purgeStore).not.toHaveBeenCalled();
    expect(repo.scrubDeliveryPayload).not.toHaveBeenCalled();
  });

  it('does not accept a completion marker belonging to another compliance topic', async () => {
    const repo = repository();
    const service = new ShopifyPrivacyService(repo);

    await expect(
      service.process(
        deliveryId,
        'customers/redact',
        { complianceTopic: 'customers/data_request', processed: true },
        localShop,
      ),
    ).rejects.toBeDefined();
    expect(repo.redactCustomerOrders).not.toHaveBeenCalled();
  });
});
