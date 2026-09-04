import { afterEach, describe, expect, it, vi } from 'vitest';
import { ShopifyBulkService } from '../../../src/modules/shopify/bulk/shopify-bulk.service.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';

const syncContext = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  shop: 'example-store.myshopify.com',
  accessToken: 'shopify-access-token',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  apiVersion: '2026-07',
  syncRunId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ShopifyBulkService', () => {
  it('starts grouped bulk queries because the streaming order importer requires parent-child adjacency', async () => {
    const requestAdminGraphql = vi
      .fn()
      .mockResolvedValueOnce({
        bulkOperationRunQuery: {
          bulkOperation: { id: 'gid://shopify/BulkOperation/1', status: 'CREATED' },
          userErrors: [],
        },
      })
      .mockResolvedValueOnce({
        bulkOperation: {
          id: 'gid://shopify/BulkOperation/1',
          status: 'RUNNING',
          errorCode: null,
          objectCount: '42',
          url: null,
          partialDataUrl: null,
        },
      });
    const apiService = { requestAdminGraphql } as unknown as ShopifyApiService;
    const service = new ShopifyBulkService(apiService);

    const started = await service.startQuery(syncContext, '{ orders { edges { node { id } } } }');
    const status = await service.getStatus(syncContext, started.id);

    expect(started).toEqual({ id: 'gid://shopify/BulkOperation/1', status: 'CREATED' });
    expect(status?.objectCount).toBe('42');
    expect(requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(requestAdminGraphql.mock.calls[0]?.[0]).toMatchObject({
      variables: { query: '{ orders { edges { node { id } } } }' },
    });
    expect(requestAdminGraphql.mock.calls[0]?.[0]?.query).toContain('groupObjects: true');
  });

  it('streams JSONL without loading the whole result into memory', async () => {
    const apiService = { requestAdminGraphql: vi.fn() } as unknown as ShopifyApiService;
    const service = new ShopifyBulkService(apiService);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"id":"one"}\n{"id":"two"}\n', {
          status: 200,
          headers: { 'content-type': 'application/jsonl' },
        }),
      ),
    );

    const rows: unknown[] = [];
    for await (const row of service.streamJsonl('https://storage.example/orders.jsonl')) {
      rows.push(row);
    }

    expect(rows).toEqual([{ id: 'one' }, { id: 'two' }]);
  });

  it('rejects provider user errors when Shopify refuses the bulk query', async () => {
    const apiService = {
      requestAdminGraphql: vi.fn().mockResolvedValue({
        bulkOperationRunQuery: {
          bulkOperation: null,
          userErrors: [{ field: ['query'], message: 'Invalid bulk query' }],
        },
      }),
    } as unknown as ShopifyApiService;
    const service = new ShopifyBulkService(apiService);

    await expect(service.startQuery(syncContext, '{ orders { edges { node { id } } } }')).rejects.toMatchObject({
      code: 'SHOPIFY_BULK_REJECTED',
    });
  });

  it('rejects a mismatched provider operation ID', async () => {
    const apiService = {
      requestAdminGraphql: vi.fn().mockResolvedValue({
        bulkOperation: {
          id: 'gid://shopify/BulkOperation/other',
          status: 'RUNNING',
          errorCode: null,
          objectCount: '1',
          url: null,
          partialDataUrl: null,
        },
      }),
    } as unknown as ShopifyApiService;
    const service = new ShopifyBulkService(apiService);

    await expect(
      service.getStatus(syncContext, 'gid://shopify/BulkOperation/expected'),
    ).rejects.toMatchObject({ code: 'SHOPIFY_BAD_RESPONSE' });
  });

  it('rejects malformed JSONL rows', async () => {
    const apiService = { requestAdminGraphql: vi.fn() } as unknown as ShopifyApiService;
    const service = new ShopifyBulkService(apiService);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"id":"valid"}\nnot-json\n', { status: 200 })),
    );

    const iterator = service.streamJsonl('https://storage.example/orders.jsonl');
    await expect(iterator.next()).resolves.toEqual({ value: { id: 'valid' }, done: false });
    await expect(iterator.next()).rejects.toMatchObject({ code: 'SHOPIFY_BAD_RESPONSE' });
  });
});
