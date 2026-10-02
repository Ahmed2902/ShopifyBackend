import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversionDeliveryService } from '../../../src/modules/conversion-delivery/conversion-delivery.service.js';
import type { DeliveryClaim } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';
import { GOOGLE_DATA_MANAGER_SCOPE } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';
import { ConversionConsentWithdrawnError } from '../../../src/modules/conversion-delivery/providers/conversion-provider.error.js';
import { deliverGooglePurchase } from '../../../src/modules/conversion-delivery/providers/google-conversion.provider.js';
import { deliverMetaPurchase } from '../../../src/modules/conversion-delivery/providers/meta-conversion.provider.js';
import { deliverTikTokPurchase } from '../../../src/modules/conversion-delivery/providers/tiktok-conversion.provider.js';

const { getApiContext } = vi.hoisted(() => ({ getApiContext: vi.fn() }));
vi.mock('../../../src/modules/google-ads/shared/google-ads-auth.service.js', () => ({
  GoogleAdsAuthService: class { getApiContext = getApiContext; },
}));
vi.mock('../../../src/modules/integrations/integration.utils.js', () => ({
  decryptSecret: vi.fn(() => 'provider-token'),
  encryptSecret: vi.fn(() => 'encrypted'),
}));

const context = { accessToken: 'google-token', scopes: [GOOGLE_DATA_MANAGER_SCOPE] };
const now = new Date('2026-10-03T00:00:00.000Z');
function claim(provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS'): DeliveryClaim {
  return {
    id: 'delivery-1', storeId: 'store-1', provider, sourceOrderId: 'order-1',
    shopifyOrderId: 'gid://shopify/Order/1001', eventKey: 'stride:purchase:1001',
    clickId: 'consented-click', eventAt: now, attributionEventAt: now,
    eventSourceUrl: 'https://shop.example/products/hero', value: '49.99',
    currencyCode: 'USD', attempts: 0,
    destination: {
      externalId: 'destination-1', accessTokenCiphertext: 'encrypted',
      configJson: { customerId: '1234567890' },
    },
  } as DeliveryClaim;
}

describe('conversion provider send-time consent', () => {
  beforeEach(() => {
    getApiContext.mockReset().mockResolvedValue(context);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      events_received: 1, fbtrace_id: 'meta-id', code: 0,
      request_id: 'tiktok-id', requestId: 'google-id',
    }), { status: 200 })));
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['META', deliverMetaPurchase], ['TIKTOK', deliverTikTokPurchase],
    ['GOOGLE_ADS', deliverGooglePurchase],
  ] as const)('blocks %s HTTP delivery when its final consent check rejects', async (provider, deliver) => {
    const withdrawn = new ConversionConsentWithdrawnError();
    const beforeSend = vi.fn().mockRejectedValue(withdrawn);
    await expect(deliver(claim(provider), beforeSend)).rejects.toBe(withdrawn);
    expect(beforeSend).toHaveBeenCalledOnce();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['META', deliverMetaPurchase], ['TIKTOK', deliverTikTokPurchase],
    ['GOOGLE_ADS', deliverGooglePurchase],
  ] as const)('awaits %s consent before allowing HTTP delivery', async (provider, deliver) => {
    let allow!: () => void;
    const beforeSend = vi.fn(() => new Promise<void>((resolve) => { allow = resolve; }));
    const pending = deliver(claim(provider), beforeSend);
    await vi.waitFor(() => expect(beforeSend).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    allow();
    await expect(pending).resolves.toHaveProperty('providerRequestId');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('discards and scrubs a Google claim withdrawn during OAuth refresh without sending or retrying', async () => {
    let finishRefresh!: (value: typeof context) => void;
    getApiContext.mockReturnValue(new Promise((resolve) => { finishRefresh = resolve; }));
    let consented = true;
    const repository = {
      recoverStaleClaims: vi.fn().mockResolvedValue(undefined),
      claimDue: vi.fn().mockResolvedValue([claim('GOOGLE_ADS')]),
      hasAdvertisingConsent: vi.fn(async () => consented),
      discardForConsent: vi.fn().mockResolvedValue(undefined),
      markDelivered: vi.fn(), markFailed: vi.fn(), pauseForBilling: vi.fn(),
    };
    const billing = { requireAdProviderReadOnly: vi.fn().mockResolvedValue(undefined) };
    const service = new ConversionDeliveryService(repository as never, () => now, billing as never);
    const pending = service.processDue();
    await vi.waitFor(() => expect(getApiContext).toHaveBeenCalledOnce());
    expect(repository.hasAdvertisingConsent).toHaveBeenCalledOnce();
    consented = false;
    finishRefresh(context);
    await expect(pending).resolves.toEqual({ claimed: 1, delivered: 0, retrying: 0, dead: 1 });
    expect(repository.hasAdvertisingConsent).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(repository.discardForConsent).toHaveBeenCalledWith('delivery-1');
    expect(repository.markDelivered).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
  });
});
