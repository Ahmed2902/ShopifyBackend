import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../src/config/env.js';
import type { BillingService } from '../../../src/modules/billing/billing.service.js';
import { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import type { ShopifyEmbeddedAuthRepository } from '../../../src/modules/shopify/embedded/shopify-embedded-auth.repository.js';
import { ShopifyEmbeddedAuthService } from '../../../src/modules/shopify/embedded/shopify-embedded-auth.service.js';
import type { ShopifyTokenExchangeService } from '../../../src/modules/shopify/embedded/shopify-token-exchange.service.js';

afterEach(() => vi.restoreAllMocks());

async function setup() {
  const shop = 'bootstrap-store.myshopify.com';
  const token = await new SignJWT({ dest: `https://${shop}`, sid: 'reopened-session' })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(env.SHOPIFY_CLIENT_ID)
    .setIssuer(`https://${shop}/admin`)
    .setSubject('42')
    .setIssuedAt()
    .setExpirationTime('1m')
    .sign(new TextEncoder().encode(env.SHOPIFY_CLIENT_SECRET));
  const repository = {
    findStoreByShop: vi
      .fn()
      .mockResolvedValue({ id: 'store', shopifyConnection: { status: 'ACTIVE' } }),
    findIdentity: vi.fn().mockResolvedValue({ userId: 'user', role: 'OWNER' }),
    refreshIdentity: vi.fn(),
    provision: vi.fn().mockResolvedValue({ storeId: 'store', userId: 'user', role: 'OWNER' }),
  };
  const exchange = {
    exchangeOffline: vi
      .fn()
      .mockResolvedValue({
        access_token: 'fresh-token',
        scope: 'read_orders',
        expires_in: 3600,
        refresh_token: 'fresh-refresh',
        refresh_token_expires_in: 7200,
      }),
    exchangeOnline: vi
      .fn()
      .mockResolvedValue({ associated_user: { id: '42', account_owner: true } }),
  };
  const billing = { ensureSubscription: vi.fn().mockResolvedValue({}) };
  const profile = vi.spyOn(ShopifyApiService.prototype, 'fetchShopProfile').mockResolvedValue({
    id: 'gid://shopify/Shop/1',
    name: 'Bootstrap',
    myshopifyDomain: shop,
    currencyCode: 'USD',
    ianaTimezone: 'UTC',
    primaryDomain: null,
    enabledPresentmentCurrencies: ['USD'],
    createdAt: new Date().toISOString(),
  });
  vi.spyOn(ShopifyApiService.prototype, 'fetchCurrentInstallationId').mockResolvedValue(
    'gid://shopify/AppInstallation/2',
  );
  const service = new ShopifyEmbeddedAuthService(
    repository as unknown as ShopifyEmbeddedAuthRepository,
    exchange as unknown as ShopifyTokenExchangeService,
    billing as unknown as BillingService,
  );
  return { token, repository, exchange, profile, service };
}

describe('Embedded bootstrap with delayed uninstall delivery', () => {
  it('replaces credentials and provisions even when the previous installation and identity still look active', async () => {
    const { token, repository, exchange, profile, service } = await setup();
    await expect(service.authenticate(token, { refreshIdentity: true })).resolves.toMatchObject({
      storeId: 'store',
      role: 'OWNER',
    });
    expect(exchange.exchangeOffline).toHaveBeenCalledOnce();
    expect(exchange.exchangeOnline).toHaveBeenCalledOnce();
    expect(profile).toHaveBeenCalledWith(
      'bootstrap-store.myshopify.com',
      'fresh-token',
      env.SHOPIFY_API_VERSION,
    );
    expect(repository.provision).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: expect.objectContaining({ verifiedAt: expect.any(Date) }),
      }),
    );
    expect(repository.findIdentity).not.toHaveBeenCalled();
    expect(repository.refreshIdentity).not.toHaveBeenCalled();
  });

  it('fails closed instead of returning the cached identity when current token exchange fails', async () => {
    const { token, repository, exchange, service } = await setup();
    exchange.exchangeOffline.mockRejectedValue(new Error('installation revoked'));
    await expect(service.authenticate(token, { refreshIdentity: true })).rejects.toThrow(
      'installation revoked',
    );
    expect(repository.provision).not.toHaveBeenCalled();
    expect(repository.findIdentity).not.toHaveBeenCalled();
  });
});
