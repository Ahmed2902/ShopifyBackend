import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';

function service() {
  const repository = {
    markConnectionReauthRequired: vi.fn().mockResolvedValue(undefined),
  } as unknown as ShopifyRepository;
  return new ShopifyApiService(repository);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('ShopifyApiService GraphQL transport', () => {
  it('retries variant queries without unitCost when Shopify denies only product-cost access', async () => {
    const requests: string[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response(
          JSON.stringify({
            errors: [
              {
                message: 'Access denied for unitCost field. Required access: view product costs.',
                extensions: { code: 'ACCESS_DENIED' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response(
          JSON.stringify({
            data: {
              productVariants: {
                nodes: [
                  {
                    id: 'gid://shopify/ProductVariant/1',
                    inventoryItem: { id: 'gid://shopify/InventoryItem/1' },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    const result = await service().requestAdminGraphql<{ productVariants: unknown }>({
      shop: 'example.myshopify.com',
      accessToken: 'token',
      apiVersion: '2026-07',
      query: `#graphql
        query CatalogVariants {
          productVariants(first: 10) {
            nodes {
              id
              inventoryItem {
                id
                unitCost { amount currencyCode }
              }
            }
          }
        }
      `,
    });

    expect(result.productVariants).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(requests[0]).toContain('unitCost');
    expect(requests[1]).not.toContain('unitCost');
  });

  it('still uses the unitCost fallback when transient failures consumed the original retry budget', async () => {
    vi.useFakeTimers();
    const requests: string[] = [];
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response('temporary', { status: 500 });
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response('temporary', { status: 500 });
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response(
          JSON.stringify({
            errors: [
              {
                message: 'Access denied for unitCost field. Required access: view product costs.',
                extensions: { code: 'ACCESS_DENIED' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      })
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        requests.push(String(init.body));
        return new Response(
          JSON.stringify({
            data: {
              productVariants: {
                nodes: [],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      });
    vi.stubGlobal('fetch', fetchMock);

    const request = service().requestAdminGraphql<{ productVariants: unknown }>({
      shop: 'example.myshopify.com',
      accessToken: 'token',
      apiVersion: '2026-07',
      query: `#graphql
        query CatalogVariants {
          productVariants(first: 10) {
            nodes {
              id
              inventoryItem {
                id
                unitCost { amount currencyCode }
              }
            }
          }
        }
      `,
    });

    await vi.runAllTimersAsync();
    const result = await request;

    expect(result.productVariants).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(requests.slice(0, 3).every((body) => body.includes('unitCost'))).toBe(true);
    expect(requests[3]).not.toContain('unitCost');
  });

  it('preserves bounded Shopify GraphQL error details for actionable sync failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            errors: [
              {
                message: 'Field inventoryLevels is not available for this installation',
                extensions: { code: 'ACCESS_DENIED' },
              },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    let caught: unknown;
    try {
      await service().requestAdminGraphql({
        shop: 'example.myshopify.com',
        accessToken: 'token',
        apiVersion: '2026-07',
        query: 'query Inventory { inventoryLevels(first: 1) { nodes { id } } }',
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AppError);
    expect(caught).toMatchObject({
      code: 'SHOPIFY_GRAPHQL_FAILED',
      statusCode: 502,
      details: {
        providerErrors: [
          {
            code: 'ACCESS_DENIED',
            message: 'Field inventoryLevels is not available for this installation',
          },
        ],
      },
    });
    expect((caught as Error).message).toContain('Field inventoryLevels is not available');
  });
});
