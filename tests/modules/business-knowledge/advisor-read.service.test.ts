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
    collections: vi.fn().mockResolvedValue({ items: [] }),
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
    overview: vi.fn(),
    products: vi.fn(),
    collections: vi.fn(),
    landingPages: vi.fn(),
  };
  const attribution = {
    sources: vi.fn(),
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
  const paidMedia = {
    capabilities: vi.fn().mockReturnValue([{ provider: 'META' }]),
    get: vi.fn().mockReturnValue(meta),
  };

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
    ),
    analytics,
    meta,
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

  it('clamps provider lookback windows to the advisor read boundary', async () => {
    const { value, meta } = createService();

    await value.paidMediaList('store-1', 'META', 'AD', { days: 999 });
    await value.paidMediaList('store-1', 'META', 'AD', { days: 0 });

    expect(meta.list).toHaveBeenNthCalledWith(1, 'store-1', 'AD', {
      days: 365,
      page: undefined,
      limit: undefined,
    });
    expect(meta.list).toHaveBeenNthCalledWith(2, 'store-1', 'AD', {
      days: 1,
      page: undefined,
      limit: undefined,
    });
  });

  it('keeps search scoped when the advisor already knows the entity type', async () => {
    const { value, analytics, meta } = createService();
    await value.search('store-1', { query: 'Hero', entityTypes: ['PRODUCT'] });

    expect(analytics.products).toHaveBeenCalledTimes(1);
    expect(meta.list).not.toHaveBeenCalled();
  });
});
