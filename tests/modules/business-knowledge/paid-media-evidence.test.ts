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

  it('maps TikTok ad groups to the normalized AD_SET level without inventing creative support', async () => {
    const monitor = {
      read: vi.fn().mockResolvedValue({
        connection: { configured: true },
        window: { days: 14 },
        counts: { campaigns: 1, groups: 2, ads: 3 },
        summary: { currencies: [] },
        hierarchy: { items: [] },
      }),
    };
    const entityReads = { read: vi.fn() };
    const provider = new TikTokPaidMediaEvidenceProvider(monitor as never, entityReads as never);

    await provider.list('store-1', 'AD_SET', { days: 14, page: 2, limit: 25 });
    const creatives = await provider.list('store-1', 'CREATIVE');

    expect(monitor.read).toHaveBeenCalledWith('store-1', {
      days: 14,
      level: 'groups',
      page: 2,
      limit: 25,
      fresh: false,
    });
    expect(creatives).toMatchObject({ unsupported: true, level: 'CREATIVE' });
  });

  it('uses an exact TikTok entity read and preserves the effective capped reporting window', async () => {
    const monitor = { read: vi.fn() };
    const entityReads = {
      read: vi.fn().mockResolvedValue({
        connection: { configured: true },
        window: { days: 90, from: '2026-06-25', to: '2026-09-22' },
        item: { id: 'campaign-250', metric: { spend: '10' } },
      }),
    };
    const provider = new TikTokPaidMediaEvidenceProvider(monitor as never, entityReads as never);

    const result = await provider.detail('store-1', 'CAMPAIGN', 'campaign-250', { days: 365 });

    expect(entityReads.read).toHaveBeenCalledWith('store-1', {
      days: 90,
      level: 'campaigns',
      entityId: 'campaign-250',
    });
    expect(result.evidence).toMatchObject({
      window: { days: 90 },
      item: { id: 'campaign-250' },
    });
    expect(result.limitations).toEqual([]);
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
