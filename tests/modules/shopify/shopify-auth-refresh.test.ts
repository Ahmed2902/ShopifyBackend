import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import {
  decryptSecret,
  encryptSecret,
} from '../../../src/modules/integrations/integration.utils.js';
import { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

function tokenResponse(accessToken: string, refreshToken: string) {
  return new Response(
    JSON.stringify({
      access_token: accessToken,
      expires_in: 3600,
      refresh_token: refreshToken,
      refresh_token_expires_in: 7_776_000,
      scope: 'read_products,read_inventory,read_locations,read_orders',
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

async function createExpiringConnection(label: string) {
  const unique = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`,
      name: `${label} Store`,
      myshopifyDomain: `${label.toLowerCase()}-${unique}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: encryptSecret('old-access-token'),
          accessTokenExpiresAt: new Date(Date.now() + 30_000),
          refreshTokenCiphertext: encryptSecret('old-refresh-token'),
          refreshTokenExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          scopes: ['read_products', 'read_inventory', 'read_locations', 'read_orders'],
          apiVersion: '2026-07',
        },
      },
    },
    select: {
      id: true,
      myshopifyDomain: true,
      shopifyConnection: { select: { id: true } },
    },
  });
  createdStoreIds.push(store.id);

  const repository = new ShopifyRepository();
  const credential = await repository.getConnectionCredentialState(store.shopifyConnection!.id);
  if (!credential) throw new Error('fixture connection was not created');

  return { store, repository, credential };
}

async function deleteStore(storeId: string) {
  await prisma.shopifyConnection.deleteMany({ where: { storeId } });
  await prisma.store.deleteMany({ where: { id: storeId } });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const storeId of createdStoreIds.splice(0)) await deleteStore(storeId);
});

describeDatabase('Shopify rotating offline-token refresh', () => {
  it('serializes concurrent refreshes so one rotating refresh token is used once', async () => {
    const { store, repository, credential } = await createExpiringConnection('Concurrent');
    const authService = new ShopifyAuthService(repository, new ShopifyApiService(repository));
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return tokenResponse('rotated-access-token', 'rotated-refresh-token');
    });
    vi.stubGlobal('fetch', fetchMock);

    const [first, second] = await Promise.all([
      authService.resolveAccessToken(store.myshopifyDomain, credential),
      authService.resolveAccessToken(store.myshopifyDomain, credential),
    ]);

    expect(first).toBe('rotated-access-token');
    expect(second).toBe('rotated-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const saved = await repository.getConnectionCredentialState(credential.id);
    expect(saved).toMatchObject({ status: 'ACTIVE', refreshClaimedAt: null });
    expect(decryptSecret(saved!.accessTokenCiphertext)).toBe('rotated-access-token');
    expect(decryptSecret(saved!.refreshTokenCiphertext!)).toBe('rotated-refresh-token');
  });

  it('retries a transient refresh failure with the same refresh token and persists one rotation', async () => {
    const { store, repository, credential } = await createExpiringConnection('Retry');
    const authService = new ShopifyAuthService(repository, new ShopifyApiService(repository));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(tokenResponse('retry-access-token', 'retry-refresh-token'));
    vi.stubGlobal('fetch', fetchMock);

    const accessToken = await authService.resolveAccessToken(store.myshopifyDomain, credential);

    expect(accessToken).toBe('retry-access-token');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const requestBodies = fetchMock.mock.calls.map(
      (call) => ((call[1] as RequestInit).body as URLSearchParams).get('refresh_token'),
    );
    expect(requestBodies).toEqual(['old-refresh-token', 'old-refresh-token']);
    const saved = await repository.getConnectionCredentialState(credential.id);
    expect(saved?.refreshClaimedAt).toBeNull();
    expect(saved?.status).toBe('ACTIVE');
  });

  it('releases the refresh claim after exhausted transient failures without forcing reauth', async () => {
    const { store, repository, credential } = await createExpiringConnection('Unavailable');
    const authService = new ShopifyAuthService(repository, new ShopifyApiService(repository));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
    );

    await expect(
      authService.resolveAccessToken(store.myshopifyDomain, credential),
    ).rejects.toMatchObject({ code: 'SHOPIFY_UNAVAILABLE' });

    const saved = await repository.getConnectionCredentialState(credential.id);
    expect(saved).toMatchObject({ status: 'ACTIVE', refreshClaimedAt: null });
  });

  it('treats exhausted refresh rate limits as transient rather than merchant reauthorization', async () => {
    const { store, repository, credential } = await createExpiringConnection('RateLimited');
    const authService = new ShopifyAuthService(repository, new ShopifyApiService(repository));
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 429, headers: { 'retry-after': '0' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      authService.resolveAccessToken(store.myshopifyDomain, credential),
    ).rejects.toMatchObject({ code: 'SHOPIFY_UNAVAILABLE' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const saved = await repository.getConnectionCredentialState(credential.id);
    expect(saved).toMatchObject({ status: 'ACTIVE', refreshClaimedAt: null });
  });

  it('marks the connection for reauthorization when the current refresh token is rejected', async () => {
    const { store, repository, credential } = await createExpiringConnection('Rejected');
    const authService = new ShopifyAuthService(repository, new ShopifyApiService(repository));
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'invalid_request' }), { status: 401 })),
    );

    await expect(
      authService.resolveAccessToken(store.myshopifyDomain, credential),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED' });

    const saved = await repository.getConnectionCredentialState(credential.id);
    expect(saved).toMatchObject({ status: 'REAUTH_REQUIRED', refreshClaimedAt: null });
  });
});
