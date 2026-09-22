import { describe, expect, it, vi } from 'vitest';
import { AdvisorReadService } from '../../../src/modules/business-knowledge/advisor-read.service.js';

function createService() {
  const knowledge = {
    context: vi.fn().mockResolvedValue({ store: { id: 'store-1' } }),
    snapshot: vi.fn().mockResolvedValue({ schemaVersion: '1.0' }),
    catalog: vi.fn().mockReturnValue({ domains: [] }),
  };
  const analytics = {
    overview: vi.fn(),
    products: vi.fn().mockResolvedValue({
      items: [{ product: { id: 'product-1', shopifyProductId: '100', title: 'Hero Hoodie' } }],
    }),
    product: vi.fn(),
    collections: vi.fn().mockResolvedValue({
      items: [{ collection: { id: 'collection-1', shopifyCollectionId: '200', title: 'Summer' } }],
    }),
    customers: vi.fn(),
    inventory: vi.fn(),
  };
  const productAds = { list: vi.fn(), detail: vi.fn() };
  const reports = { read: vi.fn() };
  const intelligence = {
    read: vi.fn().mockResolvedValue({
      evaluatedAt: new Date(),
      dataQuality: [],
      recommendations: [],
    }),
  };
  const storefront = {
    products: vi.fn(),
    collections: vi.fn(),
    landingPages: vi.fn().mockResolvedValue({
      items: [{ dimensionKey: 'landing:home', landingPageUrl: 'https://example.com/' }],
    }),
  };
  const attribution = {
    sources: vi.fn().mockResolvedValue({ items: [{ dimensionKey: 'source:META', source: 'META' }] }),
    metaAds: vi.fn(),
    paths: vi.fn(),
    mappingEvidence: vi.fn(),
  };
  const meta = {
    provider: 'META',
    capabilities: vi.fn().mockReturnValue({ provider: 'META' }),
    overview: vi.fn(),
    list: vi.fn().mockResolvedValue({
      evidence: {
        items: [
          {
            entity: { id: 'campaign-1', externalId: 'cmp-100', name: 'Retargeting Winners' },
          },
        ],
      },
    }),
    detail: vi.fn(),
  };
  const tiktok = {
    provider: 'TIKTOK',
    capabilities: vi.fn().mockReturnValue({ provider: 'TIKTOK' }),
    overview: vi.fn(),
    list: vi.fn().mockResolvedValue({
      evidence: {
        hierarchy: {
          items: [{ id: 'tiktok-campaign-1', externalId: 'tt-100', name: 'TikTok Prospecting' }],
        },
      },
    }),
    detail: vi.fn(),
  };
  const paidMedia = {
    capabilities: vi.fn().mockReturnValue([{ provider: 'META' }, { provider: 'TIKTOK' }]),
    get: vi.fn().mockImplementation((provider: string) => (provider === 'TIKTOK' ? tiktok : meta)),
  };
  const collectionDetails = { read: vi.fn().mockResolvedValue({ collection: { id: 'collection-1' } }) };
  const storefrontOverview = { read: vi.fn().mockResolvedValue({ understanding: { current: {} } }) };
  const performance = { daily: vi.fn().mockResolvedValue({ points: [] }) };
  const leaderboard = { read: vi.fn().mockResolvedValue({ items: [] }) };
  const adExposure = { list: vi.fn().mockResolvedValue({ items: [] }), detail: vi.fn() };
  const pixelHealth = { read: vi.fn().mockResolvedValue({ installation: { status: 'ACTIVE' } }) };

  return {
    value: new AdvisorReadService(
      knowledge as never,
      analytics as never,
      productAds as never,
      reports as never,
      intelligence as never,
      storefront as never,
      attribution as never,
      paidMedia as never,
      collectionDetails as never,
      storefrontOverview as never,
      performance as never,
      leaderboard as never,
      adExposure as never,
      pixelHealth as never,
    ),
    analytics,
    meta,
    tiktok,
    collectionDetails,
    storefrontOverview,
    performance,
    leaderboard,
    adExposure,
    pixelHealth,
  };
}

describe('AdvisorReadService', () => {
  it('searches business entities without exposing a database or customer PII surface', async () => {
    const { value } = createService();
    const result = await value.search('store-1', {
      query: 'hoodie',
      entityTypes: ['PRODUCT'],
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      type: 'PRODUCT',
      id: 'product-1',
      externalId: '100',
      name: 'Hero Hoodie',
      provider: 'SHOPIFY',
    });
    expect(result.privacy).toContain('customer PII');
  });

  it('uses the provider registry for paid-media drill downs', async () => {
    const { value, meta } = createService();
    await value.paidMediaList('store-1', 'META', 'CAMPAIGN', { days: 60, page: 2, limit: 25 });

    expect(meta.list).toHaveBeenCalledWith('store-1', 'CAMPAIGN', {
      days: 60,
      page: 2,
      limit: 25,
    });
  });

  it('keeps search scoped when the advisor already knows the entity type', async () => {
    const { value, analytics, meta, tiktok } = createService();
    await value.search('store-1', { query: 'Hero', entityTypes: ['PRODUCT'] });

    expect(analytics.products).toHaveBeenCalledTimes(1);
    expect(meta.list).not.toHaveBeenCalled();
    expect(tiktok.list).not.toHaveBeenCalled();
  });

  it('discovers TikTok entities without pretending creative support exists', async () => {
    const { value, tiktok } = createService();
    const result = await value.search('store-1', { query: 'prospecting', entityTypes: ['CAMPAIGN'] });

    expect(tiktok.list).toHaveBeenCalledWith('store-1', 'CAMPAIGN', {
      days: 30,
      page: 1,
      limit: 100,
    });
    expect(result.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'CAMPAIGN',
          id: 'tiktok-campaign-1',
          externalId: 'tt-100',
          provider: 'TIKTOK',
        }),
      ]),
    );
  });

  it('searches aggregate Pixel landing pages and attribution sources', async () => {
    const { value } = createService();
    const landing = await value.search('store-1', {
      query: 'example.com',
      entityTypes: ['LANDING_PAGE'],
    });
    const source = await value.search('store-1', {
      query: 'meta',
      entityTypes: ['ATTRIBUTION_SOURCE'],
    });

    expect(landing.items[0]).toMatchObject({ type: 'LANDING_PAGE', provider: 'PIXEL' });
    expect(source.items[0]).toMatchObject({ type: 'ATTRIBUTION_SOURCE', provider: 'PIXEL' });
  });

  it('delegates distinct decision-grade reads without recalculating them', async () => {
    const {
      value,
      collectionDetails,
      storefrontOverview,
      performance,
      leaderboard,
      adExposure,
      pixelHealth,
    } = createService();

    await value.collectionDetail('store-1', 'collection-1', { page: 2, limit: 10 });
    await value.storefrontOverview('store-1', 14);
    await value.performance('store-1', 14);
    await value.productLeaderboard('store-1', { days: 14, limit: 5 });
    await value.adExposureList('store-1', { days: 14, page: 1, limit: 5 });
    await value.storefrontHealth('store-1');

    expect(collectionDetails.read).toHaveBeenCalledWith('store-1', 'collection-1', 2, 10);
    expect(storefrontOverview.read).toHaveBeenCalledWith('store-1', { days: 14 });
    expect(performance.daily).toHaveBeenCalledWith('store-1', { days: 14 });
    expect(leaderboard.read).toHaveBeenCalledWith('store-1', { days: 14, limit: 5 });
    expect(adExposure.list).toHaveBeenCalledWith('store-1', { days: 14, page: 1, limit: 5 });
    expect(pixelHealth.read).toHaveBeenCalledWith('store-1');
  });
});
