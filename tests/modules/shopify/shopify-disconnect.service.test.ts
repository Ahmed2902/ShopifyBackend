import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import { ShopifyDisconnectService } from '../../../src/modules/shopify/shopify-disconnect.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const connectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function activeStore() {
  return {
    id: storeId,
    myshopifyDomain: 'example-store.myshopify.com',
    shopifyConnection: {
      id: connectionId,
      status: 'ACTIVE',
      accessTokenCiphertext: 'ciphertext',
      accessTokenExpiresAt: null,
      refreshTokenCiphertext: null,
      refreshTokenExpiresAt: null,
      scopes: ['read_products', 'write_pixels'],
      apiVersion: '2026-07',
    },
  };
}

function buildService(store = activeStore()) {
  const repository = {
    findStore: vi.fn().mockResolvedValue(store),
    markDisconnected: vi.fn().mockResolvedValue(undefined),
  };
  const authService = {
    resolveAccessToken: vi.fn().mockResolvedValue('shopify-token'),
  };
  const apiService = {
    requestAdminGraphql: vi.fn().mockResolvedValue({
      appUninstall: { app: { id: 'gid://shopify/App/1' }, userErrors: [] },
    }),
  };

  return {
    repository,
    authService,
    apiService,
    service: new ShopifyDisconnectService({
      repository: repository as never,
      authService: authService as never,
      apiService: apiService as never,
    }),
  };
}

describe('ShopifyDisconnectService', () => {
  it('uninstalls the Shopify app and disables the local connection', async () => {
    const { repository, authService, apiService, service } = buildService();

    await expect(service.disconnect(storeId)).resolves.toEqual({
      status: 'UNINSTALLED',
      shop: 'example-store.myshopify.com',
      providerUninstalled: true,
    });

    expect(authService.resolveAccessToken).toHaveBeenCalledWith(
      'example-store.myshopify.com',
      expect.objectContaining({ id: connectionId, status: 'ACTIVE' }),
    );
    expect(apiService.requestAdminGraphql).toHaveBeenCalledWith(
      expect.objectContaining({
        shop: 'example-store.myshopify.com',
        accessToken: 'shopify-token',
        apiVersion: '2026-07',
        connectionId,
        query: expect.stringContaining('appUninstall'),
      }),
    );
    expect(repository.markDisconnected).toHaveBeenCalledWith(storeId, true);
  });

  it('falls back to a local disconnect when Shopify credentials already require reauthorization', async () => {
    const { repository, authService, apiService, service } = buildService();
    authService.resolveAccessToken.mockRejectedValue(
      new AppError('reauthorize', 409, 'SHOPIFY_REAUTH_REQUIRED'),
    );

    await expect(service.disconnect(storeId)).resolves.toEqual({
      status: 'DISCONNECTED',
      shop: 'example-store.myshopify.com',
      providerUninstalled: false,
    });

    expect(apiService.requestAdminGraphql).not.toHaveBeenCalled();
    expect(repository.markDisconnected).toHaveBeenCalledWith(storeId, false);
  });

  it('does not hide provider uninstall errors behind a local disconnect', async () => {
    const { repository, apiService, service } = buildService();
    apiService.requestAdminGraphql.mockResolvedValue({
      appUninstall: {
        app: null,
        userErrors: [{ field: [], message: 'Uninstall rejected' }],
      },
    });

    await expect(service.disconnect(storeId)).rejects.toMatchObject({
      code: 'SHOPIFY_UNINSTALL_FAILED',
    });
    expect(repository.markDisconnected).not.toHaveBeenCalled();
  });

  it('is idempotent after the connection is already uninstalled', async () => {
    const store = activeStore();
    store.shopifyConnection.status = 'UNINSTALLED';
    const { repository, authService, apiService, service } = buildService(store);

    await expect(service.disconnect(storeId)).resolves.toMatchObject({
      status: 'UNINSTALLED',
      providerUninstalled: true,
    });
    expect(authService.resolveAccessToken).not.toHaveBeenCalled();
    expect(apiService.requestAdminGraphql).not.toHaveBeenCalled();
    expect(repository.markDisconnected).toHaveBeenCalledWith(storeId, true);
  });
});
