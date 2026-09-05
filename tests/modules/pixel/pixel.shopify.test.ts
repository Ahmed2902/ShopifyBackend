import { describe, expect, it, vi } from 'vitest';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import type { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';
import { ShopifyPixelProvisioner } from '../../../src/modules/pixel/pixel.shopify.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function buildProvisioner(
  scopes = ['read_products', 'write_pixels', 'read_pixels', 'read_customer_events'],
) {
  const connection = {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    status: 'ACTIVE',
    accessTokenCiphertext: 'ciphertext',
    accessTokenExpiresAt: null,
    refreshTokenCiphertext: null,
    refreshTokenExpiresAt: null,
    scopes,
    apiVersion: '2026-07',
  };
  const repository = {
    findConnectionForSync: vi.fn().mockResolvedValue({
      id: storeId,
      myshopifyDomain: 'example.myshopify.com',
      shopifyConnection: connection,
    }),
  } as unknown as ShopifyRepository;
  const apiService = {
    requestAdminGraphql: vi.fn().mockImplementation(async (input: { query: string }) => {
      if (input.query.includes('StrideWebPixelCreate')) {
        return {
          webPixelCreate: {
            userErrors: [],
            webPixel: { id: 'gid://shopify/WebPixel/1', settings: {} },
          },
        };
      }
      if (input.query.includes('StrideWebPixelUpdate')) {
        return {
          webPixelUpdate: {
            userErrors: [],
            webPixel: { id: 'gid://shopify/WebPixel/42', settings: {} },
          },
        };
      }
      return { webPixel: null };
    }),
  } as unknown as ShopifyApiService;
  const authService = {
    resolveAccessToken: vi.fn().mockResolvedValue('access-token'),
  } as unknown as ShopifyAuthService;

  return {
    repository,
    apiService,
    authService,
    provisioner: new ShopifyPixelProvisioner(repository, apiService, authService),
  };
}

describe('ShopifyPixelProvisioner', () => {
  it('requires write/read pixel and customer-event scopes before provider mutation', async () => {
    const { apiService, authService, provisioner } = buildProvisioner(['read_products']);

    await expect(
      provisioner.upsert({
        storeId,
        existingWebPixelId: null,
        settings: {
          collectorUrl: 'https://api.stride.example/v1/pixel/events',
          installationId: 'installation-id',
          collectorToken: 'collector-token',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_PIXEL_SCOPE_REQUIRED',
      details: { missingScopes: ['write_pixels', 'read_pixels', 'read_customer_events'] },
    });
    expect(authService.resolveAccessToken).not.toHaveBeenCalled();
    expect(apiService.requestAdminGraphql).not.toHaveBeenCalled();
  });

  it('looks up an existing remote WebPixel before creating when local provider id is missing', async () => {
    const { apiService, provisioner } = buildProvisioner();
    const settings = {
      collectorUrl: 'https://api.stride.example/v1/pixel/events',
      installationId: 'installation-id',
      collectorToken: 'collector-token',
    };

    await expect(
      provisioner.upsert({ storeId, existingWebPixelId: null, settings }),
    ).resolves.toEqual({ id: 'gid://shopify/WebPixel/1' });

    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiService.requestAdminGraphql).mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ query: expect.stringContaining('StrideWebPixel') }),
    );
    expect(vi.mocked(apiService.requestAdminGraphql).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        query: expect.stringContaining('webPixelCreate'),
        variables: { webPixel: { settings: JSON.stringify(settings) } },
      }),
    );
  });

  it('recovers a remotely-created WebPixel and updates it rather than creating another', async () => {
    const { apiService, provisioner } = buildProvisioner();
    vi.mocked(apiService.requestAdminGraphql).mockImplementation(async (input: { query: string }) => {
      if (input.query.includes('StrideWebPixel {')) {
        return { webPixel: { id: 'gid://shopify/WebPixel/77', settings: '{}' } };
      }
      return {
        webPixelUpdate: {
          userErrors: [],
          webPixel: { id: 'gid://shopify/WebPixel/77', settings: {} },
        },
      };
    });
    const settings = {
      collectorUrl: 'https://api.stride.example/v1/pixel/events',
      installationId: 'installation-id',
      collectorToken: 'recovery-token',
    };

    await expect(
      provisioner.upsert({ storeId, existingWebPixelId: null, settings }),
    ).resolves.toEqual({ id: 'gid://shopify/WebPixel/77' });

    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiService.requestAdminGraphql).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        query: expect.stringContaining('webPixelUpdate'),
        variables: {
          id: 'gid://shopify/WebPixel/77',
          webPixel: { settings: JSON.stringify(settings) },
        },
      }),
    );
  });

  it('verifies the live WebPixel before updating a locally stored provider id', async () => {
    const { apiService, provisioner } = buildProvisioner();
    vi.mocked(apiService.requestAdminGraphql).mockImplementation(async (input: { query: string }) => {
      if (input.query.includes('StrideWebPixel {')) {
        return { webPixel: { id: 'gid://shopify/WebPixel/42', settings: '{}' } };
      }
      return {
        webPixelUpdate: {
          userErrors: [],
          webPixel: { id: 'gid://shopify/WebPixel/42', settings: {} },
        },
      };
    });
    const settings = {
      collectorUrl: 'https://api.stride.example/v1/pixel/events',
      installationId: 'installation-id',
      collectorToken: 'rotated-token',
    };

    await expect(
      provisioner.upsert({
        storeId,
        existingWebPixelId: 'gid://shopify/WebPixel/42',
        settings,
      }),
    ).resolves.toEqual({ id: 'gid://shopify/WebPixel/42' });

    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiService.requestAdminGraphql).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        query: expect.stringContaining('webPixelUpdate'),
        variables: {
          id: 'gid://shopify/WebPixel/42',
          webPixel: { settings: JSON.stringify(settings) },
        },
      }),
    );
  });

  it('creates a replacement when the locally stored WebPixel id is stale remotely', async () => {
    const { apiService, provisioner } = buildProvisioner();
    const settings = {
      collectorUrl: 'https://api.stride.example/v1/pixel/events',
      installationId: 'installation-id',
      collectorToken: 'replacement-token',
    };

    await expect(
      provisioner.upsert({
        storeId,
        existingWebPixelId: 'gid://shopify/WebPixel/stale',
        settings,
      }),
    ).resolves.toEqual({ id: 'gid://shopify/WebPixel/1' });

    expect(apiService.requestAdminGraphql).toHaveBeenCalledTimes(2);
    expect(vi.mocked(apiService.requestAdminGraphql).mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        query: expect.stringContaining('webPixelCreate'),
        variables: { webPixel: { settings: JSON.stringify(settings) } },
      }),
    );
  });

  it('surfaces Shopify userErrors without pretending installation succeeded', async () => {
    const { apiService, provisioner } = buildProvisioner();
    vi.mocked(apiService.requestAdminGraphql).mockImplementation(async (input: { query: string }) => {
      if (input.query.includes('StrideWebPixelCreate')) {
        return {
          webPixelCreate: {
            userErrors: [
              {
                field: ['webPixel', 'settings'],
                message: 'Settings do not match the extension schema',
                code: 'INVALID',
              },
            ],
            webPixel: null,
          },
        };
      }
      return { webPixel: null };
    });

    await expect(
      provisioner.upsert({
        storeId,
        existingWebPixelId: null,
        settings: {
          collectorUrl: 'https://api.stride.example/v1/pixel/events',
          installationId: 'installation-id',
          collectorToken: 'collector-token',
        },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'SHOPIFY_PIXEL_CONFIGURATION_FAILED',
    });
  });
});
