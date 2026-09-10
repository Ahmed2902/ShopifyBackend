import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import type { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';
import { ShopifyPixelProvisioner } from '../../../src/modules/pixel/pixel.shopify.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const settings = {
  collectorUrl: 'https://api.stride.example/v1/pixel/events',
  installationId: 'installation-id',
  collectorToken: 'collector-token',
};

function buildProvisioner() {
  const repository = {
    findConnectionForSync: vi.fn().mockResolvedValue({
      id: storeId,
      myshopifyDomain: 'example.myshopify.com',
      shopifyConnection: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        status: 'ACTIVE',
        accessTokenCiphertext: 'ciphertext',
        accessTokenExpiresAt: null,
        refreshTokenCiphertext: null,
        refreshTokenExpiresAt: null,
        scopes: ['write_pixels', 'read_customer_events'],
        apiVersion: '2026-07',
      },
    }),
  } as unknown as ShopifyRepository;
  const apiService = {
    requestAdminGraphql: vi.fn(),
  } as unknown as ShopifyApiService;
  const authService = {
    resolveAccessToken: vi.fn().mockResolvedValue('access-token'),
  } as unknown as ShopifyAuthService;

  return {
    apiService,
    provisioner: new ShopifyPixelProvisioner(repository, apiService, authService),
  };
}

function missingPixelError() {
  return new AppError(
    'Shopify GraphQL request failed: No web pixel was found for this app.',
    502,
    'SHOPIFY_GRAPHQL_FAILED',
    {
      providerErrors: [
        {
          code: 'RESOURCE_NOT_FOUND',
          message: 'No web pixel was found for this app.',
        },
      ],
    },
  );
}

describe('ShopifyPixelProvisioner missing remote WebPixel handling', () => {
  it('creates the WebPixel when Shopify reports that the app has no pixel yet', async () => {
    const { apiService, provisioner } = buildProvisioner();
    vi.mocked(apiService.requestAdminGraphql)
      .mockRejectedValueOnce(missingPixelError())
      .mockResolvedValueOnce({
        webPixelCreate: {
          userErrors: [],
          webPixel: { id: 'gid://shopify/WebPixel/1', settings: {} },
        },
      });

    await expect(
      provisioner.upsert({ storeId, existingWebPixelId: null, settings }),
    ).resolves.toEqual({ id: 'gid://shopify/WebPixel/1' });

    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiService.requestAdminGraphql).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        query: expect.stringContaining('webPixelCreate'),
        variables: { webPixel: { settings: JSON.stringify(settings) } },
      }),
    );
  });

  it('reports no installation from inspect when Shopify reports no pixel', async () => {
    const { apiService, provisioner } = buildProvisioner();
    vi.mocked(apiService.requestAdminGraphql).mockRejectedValueOnce(missingPixelError());

    await expect(provisioner.inspect(storeId)).resolves.toBeNull();
  });

  it('does not swallow unrelated Shopify GraphQL failures', async () => {
    const { apiService, provisioner } = buildProvisioner();
    const error = new AppError(
      'Shopify GraphQL request failed: Access denied',
      502,
      'SHOPIFY_GRAPHQL_FAILED',
      { providerErrors: [{ code: 'ACCESS_DENIED', message: 'Access denied' }] },
    );
    vi.mocked(apiService.requestAdminGraphql).mockRejectedValueOnce(error);

    await expect(
      provisioner.upsert({ storeId, existingWebPixelId: null, settings }),
    ).rejects.toBe(error);
  });
});
