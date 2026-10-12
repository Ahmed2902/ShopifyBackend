import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { TikTokController } from '../../../src/modules/tiktok/tiktok.controller.js';
import type { TikTokService } from '../../../src/modules/tiktok/tiktok.service.js';
import { createTikTokOAuthState } from '../../../src/modules/tiktok/tiktok.utils.js';
import { env } from '../../../src/config/env.js';
import { prisma } from '../../../src/lib/prisma.js';
import { withProviderReturnShop } from '../../../src/modules/integrations/provider-return.js';

vi.mock('../../../src/lib/prisma.js', () => ({ prisma: { store: { findUnique: vi.fn() } } }));
const originalLegacy = env.LEGACY_MERCHANT_AUTH_ENABLED;
beforeEach(() => {
  env.LEGACY_MERCHANT_AUTH_ENABLED = false;
  vi.clearAllMocks();
});
afterEach(() => {
  env.LEGACY_MERCHANT_AUTH_ENABLED = originalLegacy;
});

const destination =
  'https://app.metrico.live/integrations/complete?provider=GOOGLE_ADS&status=error&storeId=signed-store';
describe('provider return navigation', () => {
  it('uses the persisted shop of the verified store and preserves provider results', async () => {
    vi.mocked(prisma.store.findUnique).mockResolvedValue({
      myshopifyDomain: 'current-store.myshopify.com',
    } as never);
    const url = new URL(await withProviderReturnShop(destination, 'signed-store'));
    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { id: 'signed-store' },
      select: { myshopifyDomain: true },
    });
    expect(url.searchParams.get('shop')).toBe('current-store.myshopify.com');
    expect(url.searchParams.get('provider')).toBe('GOOGLE_ADS');
    expect(url.searchParams.get('status')).toBe('error');
  });
  it.each([
    null,
    { myshopifyDomain: 'https://evil.example' },
    { myshopifyDomain: 'shop.myshopify.com.evil.example' },
  ])('omits navigation for missing or invalid shops: %j', async (store) => {
    vi.mocked(prisma.store.findUnique).mockResolvedValue(store as never);
    expect(
      new URL(await withProviderReturnShop(destination, 'signed-store')).searchParams.has('shop'),
    ).toBe(false);
  });
  it('leaves legacy merchant navigation unchanged without a database lookup', async () => {
    env.LEGACY_MERCHANT_AUTH_ENABLED = true;
    expect(await withProviderReturnShop(destination, 'signed-store')).toBe(destination);
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
  });
});

it('uses signed state for a denied TikTok callback and ignores supplied shop/store overrides', async () => {
  vi.mocked(prisma.store.findUnique).mockResolvedValue({
    myshopifyDomain: 'current-store.myshopify.com',
  } as never);
  const completeOAuthInstall = vi.fn();
  const controller = new TikTokController({ completeOAuthInstall } as unknown as TikTokService);
  const state = createTikTokOAuthState(
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  );
  const redirect = vi.fn();
  await controller.completeInstall(
    {
      query: {
        state,
        error: 'access_denied',
        shop: 'old-store.myshopify.com',
        storeId: 'attacker',
      },
    } as unknown as Request,
    { redirect } as unknown as Response,
  );
  expect(completeOAuthInstall).not.toHaveBeenCalled();
  expect(prisma.store.findUnique).toHaveBeenCalledWith({
    where: { id: '22222222-2222-4222-8222-222222222222' },
    select: { myshopifyDomain: true },
  });
  expect(new URL(redirect.mock.calls[0]![1]).searchParams.get('shop')).toBe(
    'current-store.myshopify.com',
  );
});
