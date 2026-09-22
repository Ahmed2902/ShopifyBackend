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
      new TikTokAdvertisingEvidenceProvider({} as never),
    ]);

    expect(registry.supportedProviders()).toEqual(ADVERTISING_PROVIDERS);
    expect(registry.capabilities().map((item) => item.provider)).toEqual(ADVERTISING_PROVIDERS);
  });

  it('preserves Meta behavior through the normalized provider boundary', async () => {
    const analytics = {
      advertising: vi.fn().mockResolvedValue({ currencies: [{ currency: 'USD' }] }),
      campaigns: vi.fn(),
      adSets: vi.fn(),
      ads: vi.fn(),
      creatives: vi.fn(),
      campaign: vi.fn(),
      adSet: vi.fn(),
      ad: vi.fn(),
      creative: vi.fn(),
    };
    const provider = new MetaAdvertisingEvidenceProvider(analytics as never);

    const result = await provider.overview('store-1', { days: 45 });

    expect(analytics.advertising).toHaveBeenCalledWith('store-1', { days: 45 });
    expect(result).toMatchObject({ provider: 'META' });
    expect(result.capabilities.attributionModel).toBe('PROVIDER_REPORTED');
  });

  it('normalizes TikTok ad groups as AD_SET while keeping unsupported creative reads explicit', async () => {
    const monitor = {
      read: vi.fn().mockResolvedValue({
        connection: { configured: true },
        window: { days: 14 },
        counts: { campaigns: 1, groups: 2, ads: 3 },
        summary: { currencies: [] },
        hierarchy: { items: [] },
      }),
    };
    const provider = new TikTokAdvertisingEvidenceProvider(monitor as never);

    await provider.list('store-1', 'AD_SET', { days: 14, page: 2, limit: 25 });
    const creatives = await provider.list('store-1', 'CREATIVE');

    expect(monitor.read).toHaveBeenCalledWith('store-1', {
      days: 14,
      level: 'groups',
      page: 2,
      limit: 25,
      fresh: false,
    });
    expect(creatives).toMatchObject({ provider: 'TIKTOK', unsupported: true, level: 'CREATIVE' });
  });
});
