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
  const stores = { findById: vi.fn().mockResolvedValue(store), ...(overrides.stores as object | undefined) };
  const dashboard = {
    read: vi.fn().mockResolvedValue({
      overview: { currency: 'USD', methodology: { commerce: 'SHOPIFY_CURRENT_ORDER_VALUE_BY_ORDER_COHORT', advertising: 'META_PROVIDER_ATTRIBUTION_GROUPED_BY_CURRENCY' }, commerce: { current: { netOrderValue: 1000 } } },
      sections: {
        inventory: { available: true, data: { items: [] } },
        intelligence: { available: true, data: { recommendations: [] } },
        recentOrders: { available: true, data: [{ id: 'order-1', name: '#1001', currentTotalAmount: 99, currencyCode: 'USD' }] },
        performance: { available: true, data: { points: [] } },
      },
    }),
    ...(overrides.dashboard as object | undefined),
  };
  const intelligence = {
    read: vi.fn().mockResolvedValue({
      evaluatedAt: new Date('2026-09-20T10:03:00.000Z'),
      windows: { decision: { from: '2026-09-14', to: '2026-09-20' }, comparison: { from: '2026-09-07', to: '2026-09-13' }, product: { from: '2026-08-24', to: '2026-09-20' } },
      evidence: { campaigns: 1, products: 1 },
      recommendations: [{ ruleId: 'margin-trap', severity: 'HIGH', title: 'Margin pressure', limitations: [{ code: 'MAPPING_PARTIAL', message: 'Some spend is unmapped.' }], evidenceQuality: 'MEDIUM' }],
      dataQuality: [{ code: 'MAPPING_COVERAGE', status: 'WARNING', surface: 'product_ads', message: 'Partial mapping' }],
    }),
    ...(overrides.intelligence as object | undefined),
  };
  const productAds = { list: vi.fn().mockResolvedValue({ currency: 'USD', methodology: { mapping: 'EXACT_SINGLE_PRODUCT_MAPPING_ONLY' }, summary: { current: { metaSpend: 100 } }, items: [] }), ...(overrides.productAds as object | undefined) };
  const storefront = { read: vi.fn().mockResolvedValue({ dataQuality: { state: 'READY', limitations: [] }, methodology: { interpretation: 'Observed behavior only' }, current: { sessions: 500 }, comparison: { sessions: 400 }, understanding: { current: { cartAbandonmentRate: 0.4 }, comparison: { cartAbandonmentRate: 0.35 }, changePoints: { cartAbandonmentRate: 0.05 } } }), ...(overrides.storefront as object | undefined) };
  const billing = { requireActive: vi.fn().mockResolvedValue({ effectivePlan: 'PRO', entitlements: { recommendationLimit: 50 } }), ...(overrides.billing as object | undefined) };
  const recommendationLifecycle = {
    attach: vi.fn().mockImplementation(async (_storeId: string, recommendations: unknown[]) => recommendations.map((recommendation, index) => ({ ...(recommendation as object), occurrenceKey: `occurrence-${index}`, lifecycleState: index === 0 ? 'REVIEWED' : 'OPEN', lifecycleUpdatedAt: index === 0 ? new Date('2026-09-20T10:04:00.000Z') : null }))),
    ...(overrides.recommendationLifecycle as object | undefined),
  };
  return { value: new BusinessKnowledgeService(stores as never, dashboard as never, intelligence as never, productAds as never, storefront as never, billing as never, recommendationLifecycle as never), stores, dashboard, intelligence, productAds, storefront, billing, recommendationLifecycle };
}

describe('BusinessKnowledgeService', () => {
  it('publishes isolated read-only knowledge and truth boundaries', () => {
    const { value } = service();
    const catalog = value.catalog();
    expect(catalog.readOnly).toBe(true);
    expect(catalog.truthModel.commerce).toContain('Shopify');
    expect(catalog.truthModel.providerAttribution).toContain('never silently substituted');
    expect(catalog.truthModel.privacy).toContain('raw order records');
    catalog.domains[0]!.sourceOfTruth.push('mutated by caller');
    expect(value.catalog().domains[0]!.sourceOfTruth).not.toContain('mutated by caller');
  });

  it('composes existing evidence on one snapshot timestamp without recalculating truth', async () => {
    const { value, dashboard, intelligence, storefront, productAds, billing, recommendationLifecycle } = service();
    const snapshot = await value.snapshot(store.id, { days: 45, fresh: true, productLimit: 5 });
    expect(dashboard.read).toHaveBeenCalledWith(store.id, { days: 45 }, expect.any(Date), { fresh: true });
    const generatedAt = dashboard.read.mock.calls[0]![2] as Date;
    expect(intelligence.read).toHaveBeenCalledWith(store.id, { fresh: true });
    expect(storefront.read).toHaveBeenCalledWith(store.id, { days: 45 }, generatedAt);
    expect(productAds.list).toHaveBeenCalledWith(store.id, { days: 45, page: 1, limit: 5 }, generatedAt);
    expect(snapshot.generatedAt).toBe(generatedAt);
    expect(billing.requireActive).toHaveBeenCalledWith(store.id);
    expect(recommendationLifecycle.attach).toHaveBeenCalledWith(store.id, expect.arrayContaining([expect.objectContaining({ ruleId: 'margin-trap' })]));
    expect(snapshot.dashboardSections).not.toHaveProperty('recentOrders');
    expect(snapshot.intelligence.available).toBe(true);
    if (snapshot.intelligence.available) {
      expect(snapshot.intelligence.data.recommendations[0]?.lifecycleState).toBe('REVIEWED');
      expect(snapshot.intelligence.data.entitlement).toEqual({ recommendationLimit: 50 });
    }
    expect(JSON.stringify(snapshot)).not.toContain('#1001');
  });

  it('caps recommendations to the active entitlement before lifecycle decoration', async () => {
    const recommendations = Array.from({ length: 12 }, (_, index) => ({ ruleId: `rule-${index}`, severity: 'MEDIUM', title: `Recommendation ${index}`, limitations: [], evidenceQuality: 'MEDIUM' }));
    const { value, recommendationLifecycle } = service({
      intelligence: { read: vi.fn().mockResolvedValue({ evaluatedAt: new Date(), windows: {}, evidence: {}, recommendations, dataQuality: [] }) },
      billing: { requireActive: vi.fn().mockResolvedValue({ effectivePlan: 'ESSENTIALS', entitlements: { recommendationLimit: 3 } }) },
    });
    const snapshot = await value.snapshot(store.id);
    expect(recommendationLifecycle.attach).toHaveBeenCalledWith(store.id, recommendations.slice(0, 3));
    if (snapshot.intelligence.available) expect(snapshot.intelligence.data.recommendations).toHaveLength(3);
  });

  it('sanitizes optional advisor failures instead of exposing infrastructure details', async () => {
    const { value } = service({ storefront: { read: vi.fn().mockRejectedValue(new Error('postgres://secret-host/internal')) }, productAds: { list: vi.fn().mockRejectedValue(new Error('Redis token leaked here')) } });
    const snapshot = await value.snapshot(store.id);
    expect(snapshot.storefront).toEqual({ available: false, data: null, error: 'Knowledge section unavailable' });
    expect(snapshot.productAds).toEqual({ available: false, data: null, error: 'Knowledge section unavailable' });
    expect(JSON.stringify(snapshot)).not.toContain('secret-host');
    expect(JSON.stringify(snapshot)).not.toContain('Redis token');
  });

  it('does not expose raw customer PII in business context', async () => {
    const context = await service().value.context(store.id);
    expect(context.store).not.toHaveProperty('memberships');
    expect(JSON.stringify(context)).not.toContain('email');
  });
});
