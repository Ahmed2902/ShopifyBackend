import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import { env } from '../../../src/config/env.js';
import { ManagedConversionSetupService } from '../../../src/modules/conversion-delivery/managed-conversion-setup.service.js';
import { TikTokAuthService } from '../../../src/modules/tiktok/shared/tiktok-auth.service.js';
import { TikTokApiService } from '../../../src/modules/tiktok/shared/tiktok-api.service.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import { deliverTikTokPurchase } from '../../../src/modules/conversion-delivery/providers/tiktok-conversion.provider.js';
import type { DeliveryClaim } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';

const requireAdProvider = vi.fn().mockResolvedValue(undefined);
const originalFlag = env.TIKTOK_EVENTS_API_ENABLED;
const service = () => new ManagedConversionSetupService(undefined, { requireAdProvider } as never);
beforeEach(() => {
  vi.restoreAllMocks();
  env.TIKTOK_EVENTS_API_ENABLED = true;
  requireAdProvider.mockReset().mockResolvedValue(undefined);
  vi.spyOn(TikTokAuthService.prototype, 'getApiContext').mockResolvedValue({
    accessToken: 'oauth-secret',
    selectedAdvertiserIds: ['123'],
    storeId: 'store-a',
  } as never);
  vi.spyOn(TikTokApiService.prototype, 'request').mockResolvedValue({
    pixels: [{ pixel_code: 'PIXEL1', pixel_name: 'Brand purchases' }],
    page_info: { total_page: 1 },
  });
});
afterEach(() => {
  env.TIKTOK_EVENTS_API_ENABLED = originalFlag;
  vi.unstubAllGlobals();
});
describe('managed TikTok conversion setup', () => {
  it('does not assume reporting OAuth means Events API approval', async () => {
    env.TIKTOK_EVENTS_API_ENABLED = false;
    expect(await service().options('store-a', 'TIKTOK')).toMatchObject({
      automaticSetupAvailable: false,
      ready: false,
    });
    expect(TikTokAuthService.prototype.getApiContext).not.toHaveBeenCalled();
    await expect(service().enable('store-a', 'TIKTOK', '123:PIXEL1')).rejects.toMatchObject({
      code: 'TIKTOK_EVENTS_APPROVAL_REQUIRED',
    });
  });
  it('discovers selected advertiser pixels without returning credentials', async () => {
    const result = await service().options('store-a', 'TIKTOK');
    expect(result.options.map((option) => option.id)).toEqual(['123:PIXEL1']);
    expect(JSON.stringify(result)).not.toContain('oauth-secret');
    expect(TikTokApiService.prototype.request).toHaveBeenCalledWith(
      expect.objectContaining({ selectedAdvertiserIds: ['123'] }),
      'pixel/list',
      { query: { advertiser_id: '123', page: 1, page_size: 100 } },
    );
  });
  it('rediscovers ownership and rejects a foreign/stale selection before storing it', async () => {
    const save = vi
      .spyOn(ConversionDeliveryRepository.prototype, 'upsertDestination')
      .mockResolvedValue({ id: 'destination' } as never);
    await expect(service().enable('store-a', 'TIKTOK', '999:PIXEL1')).rejects.toMatchObject({
      code: 'TIKTOK_CONVERSION_DESTINATION_NOT_ACCESSIBLE',
    });
    expect(save).not.toHaveBeenCalled();
    await service().enable('store-a', 'TIKTOK', '123:PIXEL1');
    expect(save).toHaveBeenCalledWith(
      'store-a',
      expect.objectContaining({
        externalId: 'PIXEL1',
        config: { authSource: 'TIKTOK_CONNECTION', advertiserId: '123' },
      }),
      undefined,
    );
  });
  it('enforces plan access before reading provider credentials', async () => {
    requireAdProvider.mockRejectedValueOnce(new Error('plan blocked'));
    await expect(service().options('store-a', 'TIKTOK')).rejects.toThrow('plan blocked');
    expect(TikTokAuthService.prototype.getApiContext).not.toHaveBeenCalled();
  });
  it('bounds pagination and rejects malformed provider responses', async () => {
    vi.mocked(TikTokApiService.prototype.request)
      .mockResolvedValueOnce({ pixels: [{ pixel_code: 'A' }], page_info: { total_page: 2 } })
      .mockResolvedValueOnce({ pixels: [{ pixel_code: 'B' }], page_info: { total_page: 2 } });
    expect(
      (await service().options('store-a', 'TIKTOK')).options.map((o) => o.destinationId),
    ).toEqual(['A', 'B']);
    vi.mocked(TikTokApiService.prototype.request).mockResolvedValue({ list: [] });
    await expect(service().options('store-a', 'TIKTOK')).rejects.toMatchObject({
      code: 'TIKTOK_PIXEL_LIST_INVALID',
    });
  });
  it('checks current pixel ownership and final consent before Events API dispatch', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ code: 0, request_id: 'receipt' }), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const claim = {
      storeId: 'store-a',
      provider: 'TIKTOK',
      eventKey: 'purchase-1',
      eventAt: new Date(),
      sourceOrderId: 'order-a',
      shopifyOrderId: 'gid://shopify/Order/1',
      value: '10',
      currencyCode: 'USD',
      clickId: 'ttclid',
      destination: {
        externalId: 'PIXEL1',
        accessTokenCiphertext: null,
        configJson: { authSource: 'TIKTOK_CONNECTION', advertiserId: '123' },
      },
    } as unknown as DeliveryClaim;
    const before = vi.fn().mockResolvedValue(undefined);
    await deliverTikTokPurchase(claim, before);
    expect(before).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/event/track/'),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Access-Token': 'oauth-secret' }),
      }),
    );
    fetchMock.mockClear();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 401, message: 'revoked' }), { status: 401 }),
    );
    await expect(deliverTikTokPurchase(claim, before)).rejects.toMatchObject({
      providerCode: 'TIKTOK_REAUTH_REQUIRED',
      retryable: true,
    });
    fetchMock.mockClear();
    before.mockRejectedValueOnce(new Error('consent withdrawn'));
    await expect(deliverTikTokPurchase(claim, before)).rejects.toThrow('consent withdrawn');
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(TikTokAuthService.prototype.getApiContext).mockRejectedValueOnce(
      new AppError('expired', 401, 'TIKTOK_REAUTH_REQUIRED'),
    );
    await expect(deliverTikTokPurchase(claim, before)).rejects.toMatchObject({
      providerCode: 'TIKTOK_REAUTH_REQUIRED',
      retryable: true,
    });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.mocked(TikTokApiService.prototype.request).mockResolvedValue({
      pixels: [],
      page_info: { total_page: 1 },
    });
    await expect(deliverTikTokPurchase(claim, before)).rejects.toMatchObject({
      providerCode: 'TIKTOK_DESTINATION_REVOKED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
