import { describe, expect, it, vi } from 'vitest';
import { BusinessKnowledgeService } from '../../../src/modules/business-knowledge/business-knowledge.service.js';

const store = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Stride Test Store',
  myshopifyDomain: 'stride-test.myshopify.com',
  currencyCode: 'USD',
  ianaTimezone: 'America/New_York',
  primaryDomainHost: 'example.com',
  primaryDomainUrl: 'https://example.com',
  enabledPresentmentCurrencies: ['USD', 'EUR'],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-09-20T00:00:00.000Z'),
  shopifyConnection: { status: 'ACTIVE', lastSyncedAt: new Date('2026-09-20T10:00:00.000Z') },
  metaConnection: { status: 'ACTIVE', lastSyncedAt: new Date('2026-09-20T10:01:00.000Z') },
  tiktokConnection: { status: 'DISCONNECTED', lastSyncedAt: null },
  pixelInstallation: { status: 'ACTIVE', lastEventAt: new Date('2026-09-20T10:02:00.000Z'), lastError: null },
};

function service(overrides: Record<string, unknown> = {}) {
  const stores = {
    findById: vi.fn().mockResolvedValue(store),
    ...(overrides.stores as object | undefined),
  };
  const dashboard = {
    read: vi.fn().mockResolvedValue({
      overview: {
        currency: 'USD',
        methodology: {
          commerce: 'SHOPIFY_CURRENT_ORDER_VALUE_BY_ORDER_COHORT',
          advertising: 'META_PROVIDER_ATTRIBUTION_GROUPED_BY_CURRENCY',
        },
        commerce: { current: { netOrderValue: 1000 } },
      },
      sections: { performance: { available: true, data: { points: [] } } },
    }),
    ...(overrides.dashboard as object | undefined),
  };
  const intelligence = {
    read: vi.fn().mockResolvedValue({
      evaluatedAt: new Date('2026-09-20T10:03:00.000Z'),
      recommendations: [
        {
          ruleId: 'margin-trap',
          severity: 'HIGH',
          title: 'Margin pressure',
          limitations: [{ code: 'MAPPING_PARTIAL', message: 'Some spend is unmapped.' }],
          evidenceQuality: 'MEDIUM',
        },
      ],
      dataQuality: [
        { code: 'MAPPING_COVERAGE', status: 'WARNING', surface: 'product_ads', message: 'Partial mapping' },
      ],
    }),
    ...(overrides.intelligence as object | undefined),
  };
  const productAds = {
    list: vi.fn().mockResolvedValue({
      currency: 'USD',
      methodology: { mapping: 'EXACT_SINGLE_PRODUCT_MAPPING_ONLY' },
      summary: { current: { metaSpend: 100 } },
      items: [],
    }),
    ...(overrides.productAds as object | undefined),
  };
  const storefront = {
    overview: vi.fn().mockResolvedValue({
      dataQuality: { state: 'READY', limitations: [] },
      methodology: { interpretation: 'Observed behavior only' },
      current: { sessions: 500 },
      comparison: { sessions: 400 },
    }),
    ...(overrides.storefront as object | undefined),
  };

  return {
    value: new BusinessKnowledgeService(
      stores as never,
      dashboard as never,
      intelligence as never,
      productAds as never,
      storefront as never,
    ),
    stores,
    dashboard,
    intelligence,
    productAds,
    storefront,
  };
}

describe('BusinessKnowledgeService', () => {
  it('publishes a discoverable read-only map of Stride knowledge and truth boundaries', () => {
    const { value } = service();
    const catalog = value.catalog();

    expect(catalog.readOnly).toBe(true);
    expect(catalog.truthModel.commerce).toContain('Shopify');
    expect(catalog.truthModel.providerAttribution).toContain('never silently substituted');
    expect(catalog.domains.map((entry) => entry.domain)).toEqual(
      expect.arrayContaining([
        'COMMERCE',
        'PAID_MEDIA',
        'STOREFRONT',
        'ATTRIBUTION',
        'PRODUCT_ADS',
        'RECOMMENDATIONS',
        'DATA_QUALITY',
      ]),
    );

    const first = catalog.domains[0]!;
    first.sourceOfTruth.push('mutated by caller');
    const fresh = value.catalog();
    expect(fresh.domains[0]!.sourceOfTruth).not.toContain('mutated by caller');
  });

  it('composes existing Stride evidence without recalculating provider or commerce truth', async () => {
    const { value, dashboard, intelligence, storefront, productAds } = service();
    const snapshot = await value.snapshot(store.id, { days: 45, fresh: true, productLimit: 5 });

    expect(dashboard.read).toHaveBeenCalledWith(
      store.id,
      { days: 45 },
      expect.any(Date),
      { fresh: true },
    );
    const generatedAt = dashboard.read.mock.calls[0]![2] as Date;
    expect(intelligence.read).toHaveBeenCalledWith(store.id, { fresh: true });
    expect(storefront.overview).toHaveBeenCalledWith(store.id, { days: 45 }, generatedAt);
    expect(productAds.list).toHaveBeenCalledWith(
      store.id,
      { days: 45, page: 1, limit: 5 },
      generatedAt,
    );
    expect(snapshot.generatedAt).toBe(generatedAt);

    expect(snapshot.overview.currency).toBe('USD');
    expect(snapshot.overview.methodology.advertising).toBe(
      'META_PROVIDER_ATTRIBUTION_GROUPED_BY_CURRENCY',
    );
    expect(snapshot.intelligence.available).toBe(true);
    if (snapshot.intelligence.available) {
      expect(snapshot.intelligence.data.recommendations[0]?.limitations).toEqual([
        { code: 'MAPPING_PARTIAL', message: 'Some spend is unmapped.' },
      ]);
      expect(snapshot.intelligence.data.dataQuality[0]?.status).toBe('WARNING');
    }
    expect(snapshot.advisorGuidance.evidenceRules.join(' ')).toContain('Shopify truth');
  });

  it('keeps optional advisor domains explicitly unavailable without exposing internal errors', async () => {
    const { value } = service({
      storefront: { overview: vi.fn().mockRejectedValue(new Error('postgres://secret-host/internal')) },
      productAds: { list: vi.fn().mockRejectedValue(new Error('Redis token leaked here')) },
    });

    const snapshot = await value.snapshot(store.id);

    expect(snapshot.storefront).toEqual({
      available: false,
      data: null,
      error: 'Knowledge section unavailable',
    });
    expect(snapshot.productAds).toEqual({
      available: false,
      data: null,
      error: 'Knowledge section unavailable',
    });
    expect(JSON.stringify(snapshot)).not.toContain('secret-host');
    expect(JSON.stringify(snapshot)).not.toContain('Redis token');
  });

  it('does not expose raw customer PII in business context', async () => {
    const { value } = service();
    const context = await value.context(store.id);
    expect(context.store).not.toHaveProperty('memberships');
    expect(JSON.stringify(context)).not.toContain('email');
  });
});
