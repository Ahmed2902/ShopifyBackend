import { describe, expect, it, vi } from 'vitest';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import type { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import type { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';
import { ShopifyPixelProvisioner } from '../../../src/modules/pixel/pixel.shopify.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

describe('ShopifyPixelProvisioner scope semantics', () => {
  it('accepts write_pixels as satisfying pixel read access when read_pixels is omitted from the token scope string', async () => {
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
          scopes: ['read_products', 'write_pixels', 'read_customer_events'],
          apiVersion: '2026-07',
        },
      }),
    } as unknown as ShopifyRepository;

    const apiService = {
      requestAdminGraphql: vi.fn().mockResolvedValue({ webPixel: null }),
    } as unknown as ShopifyApiService;

    const authService = {
      resolveAccessToken: vi.fn().mockResolvedValue('access-token'),
    } as unknown as ShopifyAuthService;

    const provisioner = new ShopifyPixelProvisioner(repository, apiService, authService);

    await expect(provisioner.inspect(storeId)).resolves.toBeNull();
    expect(authService.resolveAccessToken).toHaveBeenCalledOnce();
    expect(apiService.requestAdminGraphql).toHaveBeenCalledOnce();
  });
});
