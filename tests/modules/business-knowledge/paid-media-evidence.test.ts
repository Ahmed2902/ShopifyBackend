import { describe, expect, it, vi } from 'vitest';
import {
  MetaPaidMediaEvidenceProvider,
  PaidMediaEvidenceRegistry,
  TikTokPaidMediaEvidenceProvider,
} from '../../../src/modules/business-knowledge/paid-media-evidence.js';

describe('paid media evidence providers', () => {
  it('keeps Meta attribution explicitly provider-reported and delegates calculations to AnalyticsWorkspace', async () => {
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
    const provider = new MetaPaidMediaEvidenceProvider(analytics as never);

    const result = await provider.overview('store-1', { days: 45 });

    expect(analytics.advertising).toHaveBeenCalledWith('store-1', { days: 45 });
    expect(result.capabilities.attributionModel).toBe('PROVIDER_REPORTED');
    expect(result.capabilities.limitations.join(' ')).toContain('not Shopify purchase truth');
  });

  it('maps TikTok ad groups through the normalized GROUP level without inventing creative support', async () => {
    const canonicalReads = {
      overview: vi.fn(),
      list: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      detail: vi.fn(),
    };
    const tiktokRepository = {
      findConnectionForStore: vi.fn().mockResolvedValue({ selectedAdvertiserIds: ['adv-1'] }),
    };
    const provider = new TikTokPaidMediaEvidenceProvider(
      canonicalReads as never,
      tiktokRepository as never,
    );

    await provider.list('store-1', 'GROUP', { days: 14, page: 2, limit: 25 });
    const creatives = await provider.list('store-1', 'CREATIVE');

    expect(canonicalReads.list).toHaveBeenCalledWith({
      storeId: 'store-1',
      provider: 'TIKTOK',
      selectedAccountExternalIds: ['adv-1'],
      accountId: undefined,
      days: 14,
      level: 'GROUP',
      page: 2,
      limit: 25,
    });
    expect(creatives).toMatchObject({ unsupported: true, level: 'CREATIVE' });
  });

  it('exposes a provider-neutral registry while preserving provider-specific capabilities', () => {
    const registry = new PaidMediaEvidenceRegistry([
      new MetaPaidMediaEvidenceProvider({} as never),
      new TikTokPaidMediaEvidenceProvider({} as never, {} as never),
    ]);
    const capabilities = registry.capabilities();

    expect(capabilities.map((item) => item.provider)).toEqual(['META', 'TIKTOK']);
    expect(capabilities.find((item) => item.provider === 'META')?.supportsCreativeAnalytics).toBe(true);
    expect(capabilities.find((item) => item.provider === 'TIKTOK')?.supportsCreativeAnalytics).toBe(false);
  });
});
