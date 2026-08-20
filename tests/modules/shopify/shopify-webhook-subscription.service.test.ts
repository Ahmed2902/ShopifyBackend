import { describe, expect, it, vi } from 'vitest';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import { ShopifyWebhookSubscriptionService } from '../../../src/modules/shopify/webhook/shopify-webhook-subscription.service.js';

const base = {
  shop: 'example-store.myshopify.com',
  accessToken: 'access-token',
  apiVersion: '2026-07',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
};

function mutationResponse(kind: 'create' | 'update', topic = 'APP_UNINSTALLED') {
  const payload = {
    webhookSubscription: {
      id: 'gid://shopify/WebhookSubscription/1',
      topic,
      uri: 'http://localhost:3001/v1/integrations/shopify/webhooks',
    },
    userErrors: [],
  };
  return kind === 'create'
    ? { webhookSubscriptionCreate: payload }
    : { webhookSubscriptionUpdate: payload };
}

describe('ShopifyWebhookSubscriptionService', () => {
  it('leaves exact subscriptions alone and updates a topic pointing to an old URI', async () => {
    const requestAdminGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        webhookSubscriptions: {
          nodes: [
            {
              id: 'gid://shopify/WebhookSubscription/1',
              topic: 'APP_UNINSTALLED',
              uri: 'http://localhost:3001/v1/integrations/shopify/webhooks',
            },
            {
              id: 'gid://shopify/WebhookSubscription/2',
              topic: 'BULK_OPERATIONS_FINISH',
              uri: 'https://old.example/webhooks',
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })
      .mockResolvedValueOnce(mutationResponse('update', 'BULK_OPERATIONS_FINISH'));
    const service = new ShopifyWebhookSubscriptionService({
      requestAdminGraphql,
    } as unknown as ShopifyApiService);

    const result = await service.ensure({ ...base, scopes: [] });

    expect(result).toEqual({ created: 0, updated: 1, unchanged: 1 });
    expect(requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(requestAdminGraphql.mock.calls[1]?.[0].variables).toEqual({
      id: 'gid://shopify/WebhookSubscription/2',
      webhookSubscription: {
        uri: 'http://localhost:3001/v1/integrations/shopify/webhooks',
      },
    });
  });

  it('registers order/refund topics only when order scope is available', async () => {
    const requestAdminGraphql = vi.fn().mockResolvedValueOnce({
      webhookSubscriptions: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    for (let index = 0; index < 6; index += 1) {
      requestAdminGraphql.mockResolvedValueOnce(mutationResponse('create'));
    }
    const service = new ShopifyWebhookSubscriptionService({
      requestAdminGraphql,
    } as unknown as ShopifyApiService);

    const result = await service.ensure({ ...base, scopes: ['read_orders'] });

    expect(result).toEqual({ created: 6, updated: 0, unchanged: 0 });
    const createdTopics = requestAdminGraphql.mock.calls
      .slice(1)
      .map((call) => call[0].variables?.topic);
    expect(createdTopics).toEqual(
      expect.arrayContaining([
        'APP_UNINSTALLED',
        'BULK_OPERATIONS_FINISH',
        'ORDERS_CREATE',
        'ORDERS_UPDATED',
        'ORDERS_DELETE',
        'REFUNDS_CREATE',
      ]),
    );
    expect(createdTopics).not.toContain('PRODUCTS_UPDATE');
    expect(createdTopics).not.toContain('INVENTORY_LEVELS_UPDATE');
  });

  it('accepts write scope as the equivalent permission for managed read topics', async () => {
    const requestAdminGraphql = vi.fn().mockResolvedValueOnce({
      webhookSubscriptions: {
        nodes: [],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    for (let index = 0; index < 5; index += 1) {
      requestAdminGraphql.mockResolvedValueOnce(mutationResponse('create'));
    }
    const service = new ShopifyWebhookSubscriptionService({
      requestAdminGraphql,
    } as unknown as ShopifyApiService);

    await service.ensure({ ...base, scopes: ['write_products'] });

    const createdTopics = requestAdminGraphql.mock.calls
      .slice(1)
      .map((call) => call[0].variables?.topic);
    expect(createdTopics).toEqual(
      expect.arrayContaining([
        'PRODUCTS_CREATE',
        'PRODUCTS_UPDATE',
        'PRODUCTS_DELETE',
      ]),
    );
  });

  it('surfaces Shopify subscription mutation user errors', async () => {
    const requestAdminGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        webhookSubscriptions: {
          nodes: [],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })
      .mockResolvedValueOnce({
        webhookSubscriptionCreate: {
          webhookSubscription: null,
          userErrors: [{ field: ['webhookSubscription'], message: 'Invalid URI' }],
        },
      });
    const service = new ShopifyWebhookSubscriptionService({
      requestAdminGraphql,
    } as unknown as ShopifyApiService);

    await expect(service.ensure({ ...base, scopes: [] })).rejects.toMatchObject({
      code: 'SHOPIFY_WEBHOOK_SUBSCRIPTION_FAILED',
    });
  });
});
