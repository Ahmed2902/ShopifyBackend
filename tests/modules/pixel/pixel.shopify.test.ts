import { describe, expect, it, vi } from 'vitest';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import type { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';
import { ShopifyPixelProvisioner } from '../../../src/modules/pixel/pixel.shopify.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function buildProvisioner(scopes = ['read_products', 'write_pixels', 'read_customer_events']) {
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
    requestAdminGraphql: vi.fn().mockResolvedValue({
      webPixelCreate: {
        userErrors: [],
        webPixel: { id: 'gid://shopify/WebPixel/1', settings: {} },
      },
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
  it('requires both pixel/customer-event scopes before provider mutation', async () => {
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
      details: { missingScopes: ['write_pixels', 'read_customer_events'] },
    });
    expect(authService.resolveAccessToken).not.toHaveBeenCalled();
    expect(apiService.requestAdminGraphql).not.toHaveBeenCalled();
  });

  it('creates a Shopify WebPixel with Stride collector settings', async () => {
    const { apiService, authService, provisioner } = buildProvisioner();
    const settings = {
      collectorUrl: 'https://api.stride.example/v1/pixel/events',
      installationId: 'installation-id',
      collectorToken: 'collector-token',
    };

    await expect(
      provisioner.upsert({ storeId, existingWebPixelId: null, settings }),
    ).resolves.toEqual({ id: 'gid://shopify/WebPixel/1' });

    expect(authService.resolveAccessToken).toHaveBeenCalledWith(
      'example.myshopify.com',
      expect.objectContaining({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }),
    );
    expect(apiService.requestAdminGraphql).toHaveBeenCalledWith(
      expect.objectContaining({
        shop: 'example.myshopify.com',
        accessToken: 'access-token',
        apiVersion: '2026-07',
        connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        query: expect.stringContaining('webPixelCreate'),
        variables: { webPixel: { settings } },
      }),
    );
  });

  it('updates the existing provider WebPixel instead of creating a second one', async () => {
    const { apiService, provisioner } = buildProvisioner();
    vi.mocked(apiService.requestAdminGraphql).mockResolvedValue({
      webPixelUpdate: {
        userErrors: [],
        webPixel: { id: 'gid://shopify/WebPixel/42', settings: {} },
      },
    });

    await expect(
      provisioner.upsert({
        storeId,
        existingWebPixelId: 'gid://shopify/WebPixel/42',
        settings: {
          collectorUrl: 'https://api.stride.example/v1/pixel/events',
          installationId: 'installation-id',
          collectorToken: 'rotated-token',
        },
      }),
    ).resolves.toEqual({ id: 'gid://shopify/WebPixel/42' });

    expect(apiService.requestAdminGraphql).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.stringContaining('webPixelUpdate'),
        variables: expect.objectContaining({ id: 'gid://shopify/WebPixel/42' }),
      }),
    );
  });

  it('surfaces Shopify userErrors without pretending installation succeeded', async () => {
    const { apiService, provisioner } = buildProvisioner();
    vi.mocked(apiService.requestAdminGraphql).mockResolvedValue({
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
