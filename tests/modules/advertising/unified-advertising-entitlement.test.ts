import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import { UnifiedAdvertisingScopeService } from '../../../src/modules/advertising/unified-advertising-scope.service.js';

const metaAccount = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'META' as const,
  providerEntityId: 'act_1',
  name: 'Meta',
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  lastSyncedAt: new Date(),
};
const googleAccount = {
  id: '22222222-2222-4222-8222-222222222222',
  provider: 'GOOGLE_ADS' as const,
  providerEntityId: '1234567890',
  name: 'Google',
  status: 'ACTIVE',
  currency: 'USD',
  timezone: 'UTC',
  lastSyncedAt: new Date(),
};

function state(provider: 'META' | 'TIKTOK' | 'GOOGLE_ADS', selectedExternalIds: string[]) {
  return {
    provider,
    status: 'ACTIVE',
    selectedExternalIds,
    lastSyncedAt: new Date(),
    lastSyncStatus: 'SUCCEEDED',
  };
}

function repository() {
  return {
    connectionStates: vi.fn().mockResolvedValue([
      state('META', ['act_1']),
      state('GOOGLE_ADS', ['1234567890']),
    ]),
    selectedAccounts: vi.fn().mockResolvedValue([metaAccount, googleAccount]),
  };
}

describe('unified advertising channel entitlements', () => {
  it('keeps every selected provider on Pro', async () => {
    const billing = {
      requireActive: vi.fn().mockResolvedValue({
        entitlements: { maxAdChannels: null },
        essentialsAdProvider: null,
      }),
      requireAdProviderReadOnly: vi.fn(),
    };
    const service = new UnifiedAdvertisingScopeService(repository() as never, billing as never);
    const result = await service.resolve({ storeId: 'store', provider: 'ALL' });
    expect(result.accounts.map((account) => account.provider).sort()).toEqual([
      'GOOGLE_ADS',
      'META',
    ]);
  });

  it('narrows provider=ALL to the Essentials selected channel', async () => {
    const billing = {
      requireActive: vi.fn().mockResolvedValue({
        entitlements: { maxAdChannels: 1 },
        essentialsAdProvider: 'META',
      }),
      requireAdProviderReadOnly: vi.fn(),
    };
    const service = new UnifiedAdvertisingScopeService(repository() as never, billing as never);
    const result = await service.resolve({ storeId: 'store', provider: 'ALL' });
    expect(result.accounts).toEqual([metaAccount]);
    expect(result.states.map((item) => item.provider)).toEqual(['META']);
  });

  it('rejects an explicit provider outside the Essentials selected channel', async () => {
    const billing = {
      requireActive: vi.fn().mockResolvedValue({
        entitlements: { maxAdChannels: 1 },
        essentialsAdProvider: 'META',
      }),
      requireAdProviderReadOnly: vi.fn().mockRejectedValue(
        new AppError('Channel not included', 403, 'PLAN_AD_CHANNEL_LIMIT'),
      ),
    };
    const service = new UnifiedAdvertisingScopeService(repository() as never, billing as never);
    await expect(
      service.resolve({ storeId: 'store', provider: 'GOOGLE_ADS' }),
    ).rejects.toMatchObject({ code: 'PLAN_AD_CHANNEL_LIMIT', statusCode: 403 });
  });

  it('requires channel selection when Essentials has multiple connected providers and none selected', async () => {
    const billing = {
      requireActive: vi.fn().mockResolvedValue({
        entitlements: { maxAdChannels: 1 },
        essentialsAdProvider: null,
      }),
      requireAdProviderReadOnly: vi.fn().mockRejectedValue(
        new AppError('Choose a channel', 409, 'PLAN_CHANNEL_SELECTION_REQUIRED'),
      ),
    };
    const service = new UnifiedAdvertisingScopeService(repository() as never, billing as never);
    await expect(service.resolve({ storeId: 'store', provider: 'ALL' })).rejects.toMatchObject({
      code: 'PLAN_CHANNEL_SELECTION_REQUIRED',
      statusCode: 409,
    });
  });

  it('validates selected account first, then applies its provider entitlement', async () => {
    const billing = {
      requireActive: vi.fn().mockResolvedValue({
        entitlements: { maxAdChannels: 1 },
        essentialsAdProvider: 'META',
      }),
      requireAdProviderReadOnly: vi.fn().mockRejectedValue(
        new AppError('Channel not included', 403, 'PLAN_AD_CHANNEL_LIMIT'),
      ),
    };
    const service = new UnifiedAdvertisingScopeService(repository() as never, billing as never);
    await expect(
      service.resolve({ storeId: 'store', provider: 'ALL', accountId: googleAccount.id }),
    ).rejects.toMatchObject({ code: 'PLAN_AD_CHANNEL_LIMIT', statusCode: 403 });
    expect(billing.requireAdProviderReadOnly).toHaveBeenCalledWith('store', 'GOOGLE_ADS');
  });
});
