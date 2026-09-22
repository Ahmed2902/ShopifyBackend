import { describe, expect, it, vi } from 'vitest';
import {
  AdvertisingProviderRegistry,
  MetaAdvertisingEvidenceProvider,
  TikTokAdvertisingEvidenceProvider,
} from '../../../src/modules/advertising/advertising.provider.js';
import { ADVERTISING_PROVIDERS } from '../../../src/modules/integrations/integration.schema.js';

describe('advertising provider registry', () => {
  it('keeps the supported provider list and capabilities provider-neutral', () => {
    const registry = new AdvertisingProviderRegistry([
      new MetaAdvertisingEvidenceProvider({} as never),
      new TikTokAdvertisingEvidenceProvider({} as never, {} as never),
    ]);

    expect(registry.supportedProviders()).toEqual(ADVERTISING_PROVIDERS);
    expect(registry.capabilities().map((item) => item.provider)).toEqual(ADVERTISING_PROVIDERS);
    expect(registry.capabilities().flatMap((item) => item.levels)).not.toContain('AD_SET');
    expect(registry.capabilities()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'META', groupKinds: ['AD_SET'], groupLabel: 'Ad Set' }),
        expect.objectContaining({ provider: 'TIKTOK', groupKinds: ['AD_GROUP'], groupLabel: 'Ad Group' }),
      ]),
    );
  });

  it('preserves Meta behavior through the normalized GROUP boundary', async () => {
    const analytics = {
      advertising: vi.fn().mockResolvedValue({ currencies: [{ currency: 'USD' }] }),
      campaigns: vi.fn(),
      adSets: vi.fn().mockResolvedValue({ items: [] }),
      ads: vi.fn(),
      creatives: vi.fn(),
      campaign: vi.fn(),
      adSet: vi.fn(),
      ad: vi.fn(),
      creative: vi.fn(),
    };
    const provider = new MetaAdvertisingEvidenceProvider(analytics as never);

    const result = await provider.overview('store-1', { days: 45 });
    await provider.list('store-1', 'GROUP', { days: 7, page: 2, limit: 25 });

    expect(analytics.advertising).toHaveBeenCalledWith('store-1', { days: 45 });
    expect(analytics.adSets).toHaveBeenCalledWith('store-1', { days: 7, page: 2, limit: 25 });
    expect(result).toMatchObject({ provider: 'META' });
    expect(result.capabilities.attributionModel).toBe('PROVIDER_REPORTED');
  });

  it('uses canonical TikTok runtime reads and keeps unsupported creative reads explicit', async () => {
    const canonicalReads = {
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      overview: vi.fn(),
      detail: vi.fn(),
    };
    const tiktokRepository = {
      findConnectionForStore: vi.fn().mockResolvedValue({ selectedAdvertiserIds: ['adv-1'] }),
    };
    const provider = new TikTokAdvertisingEvidenceProvider(
      canonicalReads as never,
      tiktokRepository as never,
    );

    await provider.list('store-1', 'GROUP', {
      accountId: '11111111-1111-4111-8111-111111111111',
      days: 14,
      page: 2,
      limit: 25,
    });
    const creatives = await provider.list('store-1', 'CREATIVE');

    expect(canonicalReads.list).toHaveBeenCalledWith({
      storeId: 'store-1',
      provider: 'TIKTOK',
      selectedAccountExternalIds: ['adv-1'],
      accountId: '11111111-1111-4111-8111-111111111111',
      days: 14,
      level: 'GROUP',
      page: 2,
      limit: 25,
    });
    expect(creatives).toMatchObject({ provider: 'TIKTOK', unsupported: true, level: 'CREATIVE' });
  });
});
