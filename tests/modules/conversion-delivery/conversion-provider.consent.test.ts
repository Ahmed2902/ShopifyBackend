import { normalizeCustomerMatching } from '../../../src/modules/conversion-delivery/matching.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversionDeliveryService } from '../../../src/modules/conversion-delivery/conversion-delivery.service.js';
import type { DeliveryClaim } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';
import { GOOGLE_DATA_MANAGER_SCOPE } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';
import { ConversionConsentWithdrawnError, ConversionProviderError } from '../../../src/modules/conversion-delivery/providers/conversion-provider.error.js';
import { deliverGooglePurchase } from '../../../src/modules/conversion-delivery/providers/google-conversion.provider.js';
import { deliverMetaPurchase } from '../../../src/modules/conversion-delivery/providers/meta-conversion.provider.js';
import { deliverTikTokPurchase } from '../../../src/modules/conversion-delivery/providers/tiktok-conversion.provider.js';

const { getApiContext } = vi.hoisted(() => ({ getApiContext: vi.fn() }));
vi.mock('../../../src/modules/google-ads/shared/google-ads-auth.service.js', () => ({
  GoogleAdsAuthService: class {
    getApiContext = getApiContext;
  },
}));
vi.mock('../../../src/modules/integrations/integration.utils.js', () => ({
  decryptSecret: vi.fn(() => 'provider-token'),
  encryptSecret: vi.fn(() => 'encrypted'),
}));

const context = { accessToken: 'google-token', scopes: [GOOGLE_DATA_MANAGER_SCOPE] };
const now = new Date('2026-10-03T00:00:00.000Z');
function claim(provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS'): DeliveryClaim {
  return {
    id: 'delivery-1',
    storeId: 'store-1',
    provider,
    sourceOrderId: 'order-1',
    shopifyOrderId: 'gid://shopify/Order/1001',
    eventKey: 'stride:purchase:1001',
    clickId: 'consented-click',
    eventAt: now,
    attributionEventAt: now,
    eventSourceUrl: 'https://shop.example/products/hero',
    value: '49.99',
    currencyCode: 'USD',
    attempts: 0,
    destination: {
      externalId: 'destination-1',
      accessTokenCiphertext: 'encrypted',
      configJson: { customerId: '1234567890' },
    },
  } as DeliveryClaim;
}

describe('conversion provider send-time consent', () => {
  beforeEach(() => {
    getApiContext.mockReset().mockResolvedValue(context);
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            events_received: 1,
            fbtrace_id: 'meta-id',
            code: 0,
            request_id: 'tiktok-id',
            requestId: 'google-id',
          }),
          { status: 200 },
        ),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each([
    ['META', deliverMetaPurchase],
    ['TIKTOK', deliverTikTokPurchase],
    ['GOOGLE_ADS', deliverGooglePurchase],
  ] as const)(
    'blocks %s HTTP delivery when its final consent check rejects',
    async (provider, deliver) => {
      const withdrawn = new ConversionConsentWithdrawnError();
      const beforeSend = vi.fn().mockRejectedValue(withdrawn);
      await expect(deliver(claim(provider), beforeSend)).rejects.toBe(withdrawn);
      expect(beforeSend).toHaveBeenCalledOnce();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['META', deliverMetaPurchase],
    ['TIKTOK', deliverTikTokPurchase],
    ['GOOGLE_ADS', deliverGooglePurchase],
  ] as const)('awaits %s consent before allowing HTTP delivery', async (provider, deliver) => {
    let allow!: () => void;
    const beforeSend = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          allow = resolve;
        }),
    );
    const pending = deliver(claim(provider), beforeSend);
    await vi.waitFor(() => expect(beforeSend).toHaveBeenCalledOnce());
    expect(fetch).not.toHaveBeenCalled();
    allow();
    await expect(pending).resolves.toHaveProperty('providerRequestId');
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('discards and scrubs a Google claim withdrawn during OAuth refresh without sending or retrying', async () => {
    let finishRefresh!: (value: typeof context) => void;
    getApiContext.mockReturnValue(
      new Promise((resolve) => {
        finishRefresh = resolve;
      }),
    );
    let consented = true;
    const repository = {
      recoverStaleClaims: vi.fn().mockResolvedValue(undefined),
      claimDue: vi.fn().mockResolvedValue([claim('GOOGLE_ADS')]),
      hasAdvertisingConsent: vi.fn(async () => consented),
      discardForConsent: vi.fn().mockResolvedValue(undefined),
      markDelivered: vi.fn(),
      markFailed: vi.fn(),
      pauseForBilling: vi.fn(),
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
  it.each([
    ['META', deliverMetaPurchase, { fbc: 'fb.1.1790985600000.actual-click' }],
    ['META', deliverMetaPurchase, { fbp: 'fb.1.1790985600000.123' }],
    [
      'META',
      deliverMetaPurchase,
      normalizeCustomerMatching({ emails: ['Shopper@Example.com'], phones: ['+201001234567'] }),
    ],
    ['TIKTOK', deliverTikTokPurchase, { ttp: 'actual-cookie' }],
    ['TIKTOK', deliverTikTokPurchase, normalizeCustomerMatching({ externalId: 'store-pseudonym' })],
    [
      'GOOGLE_ADS',
      deliverGooglePurchase,
      normalizeCustomerMatching({ emails: ['Shopper@Example.com'] }),
    ],
  ] as const)(
    'sends permitted %s matching without a click ID and without raw customer fields',
    async (provider, deliver, match) => {
      const delivery = { ...claim(provider), clickId: null, match } as DeliveryClaim;
      await deliver(delivery, async () => undefined);
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
      expect(JSON.stringify(body)).not.toContain('Shopper@');
      expect(JSON.stringify(body)).not.toContain('store-1');
      if (provider === 'META') expect(body.data[0].user_data).toBeDefined();
      if (provider === 'TIKTOK') expect(body.data[0].user).toBeDefined();
      if (provider === 'GOOGLE_ADS') {
        expect(body.events[0].userData.userIdentifiers).toHaveLength(1);
        expect(body.encoding).toBe('HEX');
      }
    },
  );
  it.each(['gbraid', 'wbraid'])(
    'uses the Google %s field instead of relabeling it gclid',
    async (clickIdKind) => {
      await deliverGooglePurchase({ ...claim('GOOGLE_ADS'), clickIdKind }, async () => undefined);
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
      expect(body.events[0].adIdentifiers).toEqual({ [clickIdKind]: 'consented-click' });
    },
  );
  it.each([
    ['META', deliverMetaPurchase, 'PAGE_VIEW', 'PageView'],
    ['META', deliverMetaPurchase, 'PRODUCT_VIEW', 'ViewContent'],
    ['TIKTOK', deliverTikTokPurchase, 'ADD_TO_CART', 'AddToCart'],
    ['TIKTOK', deliverTikTokPurchase, 'BEGIN_CHECKOUT', 'InitiateCheckout'],
  ] as const)(
    'maps %s %s and omits unknown commerce values',
    async (provider, deliver, eventName, expected) => {
      await deliver(
        {
          ...claim(provider),
          eventName,
          sourceOrderId: null,
          shopifyOrderId: null,
          value: null,
          currencyCode: null,
        } as DeliveryClaim,
        async () => undefined,
      );
      const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string);
      expect(body.data[0].event_name ?? body.data[0].event).toBe(expected);
      expect(body.data[0].custom_data ?? body.data[0].properties).toEqual({});
    },
  );
  it.each([
    ['META', deliverMetaPurchase], ['TIKTOK', deliverTikTokPurchase], ['GOOGLE_ADS', deliverGooglePurchase],
  ] as const)('rejects missing %s Purchase money without silently turning it into zero', async (provider, deliver) => {
    await expect(deliver({ ...claim(provider), value: null } as DeliveryClaim, async () => undefined))
      .rejects.toHaveProperty('providerCode', 'COMMERCE_TRUTH_MISSING');
    expect(fetch).not.toHaveBeenCalled();
    await deliver({ ...claim(provider), value: '0' } as unknown as DeliveryClaim, async () => undefined);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('pauses a claim if billing is revoked during OAuth refresh without consuming a provider attempt', async () => {
    let finishRefresh!: (value: typeof context) => void;
    getApiContext.mockReturnValue(new Promise(resolve => { finishRefresh = resolve; }));
    let allowed = true;
    const repository = {
      recoverStaleClaims: vi.fn().mockResolvedValue(undefined), claimDue: vi.fn().mockResolvedValue([claim('GOOGLE_ADS')]),
      hasAdvertisingConsent: vi.fn().mockResolvedValue(true), discardForConsent: vi.fn(),
      markDelivered: vi.fn(), markFailed: vi.fn(), pauseForBilling: vi.fn().mockResolvedValue(undefined),
    };
    const billing = { requireAdProviderReadOnly: vi.fn(async () => { if (!allowed) throw new Error('revoked'); }) };
    const service = new ConversionDeliveryService(repository as never, () => now, billing as never);
    const pending = service.processDue();
    await vi.waitFor(() => expect(getApiContext).toHaveBeenCalledOnce());
    allowed = false; finishRefresh(context);
    await expect(pending).resolves.toEqual({ claimed: 1, delivered: 0, retrying: 1, dead: 0 });
    expect(repository.pauseForBilling).toHaveBeenCalledOnce();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects unsupported TikTok PageView and Google funnel uploads without HTTP', async () => {
    await expect(
      deliverTikTokPurchase(
        { ...claim('TIKTOK'), eventName: 'PAGE_VIEW' } as DeliveryClaim,
        async () => undefined,
      ),
    ).rejects.toHaveProperty('providerCode', 'TIKTOK_EVENT_UNSUPPORTED');
    await expect(
      deliverGooglePurchase(
        { ...claim('GOOGLE_ADS'), eventName: 'PRODUCT_VIEW' } as DeliveryClaim,
        async () => undefined,
      ),
    ).rejects.toHaveProperty('providerCode', 'GOOGLE_FUNNEL_UNSUPPORTED');
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('recoverable provider availability during worker preflight', () => {
  it('pauses a managed connection without consuming retries or treating it as shopper withdrawal', async () => {
    const repository = {
      recoverStaleClaims: vi.fn().mockResolvedValue(undefined), claimDue: vi.fn().mockResolvedValue([claim('META')]),
      hasAdvertisingConsent: vi.fn().mockRejectedValue(new ConversionProviderError('Reconnect the channel', true, 'CONVERSION_CONNECTION_REAUTH_REQUIRED')),
      pauseForConnection: vi.fn().mockResolvedValue(undefined),
      pauseForBilling: vi.fn(), discardForConsent: vi.fn(), markDelivered: vi.fn(), markFailed: vi.fn(),
    };
    const billing = { requireAdProviderReadOnly: vi.fn().mockResolvedValue(undefined) };
    await expect(new ConversionDeliveryService(repository as never, () => now, billing as never).processDue())
      .resolves.toEqual({ claimed: 1, delivered: 0, retrying: 1, dead: 0 });
    expect(repository.pauseForConnection).toHaveBeenCalledOnce();
    expect(repository.discardForConsent).not.toHaveBeenCalled();
    expect(repository.markFailed).not.toHaveBeenCalled();
    expect(repository.markDelivered).not.toHaveBeenCalled();
  });
});
