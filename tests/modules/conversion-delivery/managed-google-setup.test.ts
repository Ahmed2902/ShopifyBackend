import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ManagedConversionSetupService } from '../../../src/modules/conversion-delivery/managed-conversion-setup.service.js';
import { GoogleAdsAuthService } from '../../../src/modules/google-ads/shared/google-ads-auth.service.js';
import { GoogleAdsApiService } from '../../../src/modules/google-ads/shared/google-ads-api.service.js';
import { GoogleAdsRepository } from '../../../src/modules/google-ads/google-ads.repository.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import { GOOGLE_DATA_MANAGER_SCOPE } from '../../../src/modules/conversion-delivery/conversion-delivery.types.js';

const account = {
  customerId: '123',
  loginCustomerId: '456',
  descriptiveName: 'Brand account',
  manager: false,
};
const action = {
  id: '789',
  name: 'Confirmed purchases',
  status: 'ENABLED',
  type: 'UPLOAD_CLICKS',
  category: 'PURCHASE',
  ownerCustomer: 'customers/123',
};
const requireAdProvider = vi.fn().mockResolvedValue(undefined);
function service() {
  return new ManagedConversionSetupService(undefined, { requireAdProvider } as never);
}
describe('managed Google purchase setup', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    requireAdProvider.mockClear();
    vi.spyOn(GoogleAdsAuthService.prototype, 'getApiContext').mockResolvedValue({
      storeId: 'store-a',
      connectionId: 'connection-a',
      accessToken: 'secret',
      apiVersion: 'v23',
      scopes: [GOOGLE_DATA_MANAGER_SCOPE],
      selectedCustomerIds: ['123'],
    });
    vi.spyOn(GoogleAdsRepository.prototype, 'findSelectedCustomers').mockResolvedValue([
      account,
    ] as never);
    vi.spyOn(GoogleAdsApiService.prototype, 'search').mockResolvedValue([
      { conversionAction: action },
    ]);
  });
  it('discovers only owned, enabled Purchase upload actions in selected accounts', async () => {
    vi.mocked(GoogleAdsApiService.prototype.search).mockResolvedValue([
      action,
      { conversionAction: action },
      { conversionAction: { ...action, ownerCustomer: 'customers/999' } },
      { conversionAction: { ...action, status: 'REMOVED' } },
      { conversionAction: { ...action, category: 'SIGNUP' } },
      { conversionAction: { ...action, type: 'WEBPAGE' } },
    ]);
    const result = await service().options('store-a', 'GOOGLE_ADS');
    expect(result.ready).toBe(true);
    expect(result.options.map((row) => row.id)).toEqual(['123:789']);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(GoogleAdsRepository.prototype.findSelectedCustomers).toHaveBeenCalledWith('store-a', [
      '123',
    ]);
  });
  it('requires Data Manager reconsent before discovery and does not infer scope', async () => {
    vi.mocked(GoogleAdsAuthService.prototype.getApiContext).mockResolvedValue({
      scopes: ['https://www.googleapis.com/auth/adwords'],
      selectedCustomerIds: ['123'],
    } as never);
    expect(await service().options('store-a', 'GOOGLE_ADS')).toMatchObject({
      needsPermission: true,
      ready: false,
      options: [],
    });
    expect(GoogleAdsApiService.prototype.search).not.toHaveBeenCalled();
    await expect(service().enable('store-a', 'GOOGLE_ADS', '123:789')).rejects.toMatchObject({
      code: 'GOOGLE_DATA_MANAGER_SCOPE_REQUIRED',
    });
  });
  it('rediscovers before saving and rejects a stale or foreign selection', async () => {
    vi.spyOn(ConversionDeliveryRepository.prototype, 'upsertDestination').mockResolvedValue({
      id: 'destination',
    } as never);
    await expect(service().enable('store-a', 'GOOGLE_ADS', '999:789')).rejects.toMatchObject({
      code: 'GOOGLE_CONVERSION_DESTINATION_NOT_ACCESSIBLE',
    });
    expect(ConversionDeliveryRepository.prototype.upsertDestination).not.toHaveBeenCalled();
    await service().enable('store-a', 'GOOGLE_ADS', '123:789');
    expect(ConversionDeliveryRepository.prototype.upsertDestination).toHaveBeenCalledWith(
      'store-a',
      {
        provider: 'GOOGLE_ADS',
        externalId: '789',
        displayName: 'Confirmed purchases',
        config: { authSource: 'GOOGLE_ADS_CONNECTION', customerId: '123', loginCustomerId: '456' },
      },
      undefined,
    );
  });
  it('enforces entitlement before reading provider credentials', async () => {
    requireAdProvider.mockRejectedValueOnce(new Error('plan blocked'));
    await expect(service().options('store-a', 'GOOGLE_ADS')).rejects.toThrow('plan blocked');
    expect(GoogleAdsAuthService.prototype.getApiContext).not.toHaveBeenCalled();
  });
});
