import { describe, expect, it, vi } from 'vitest';
import { UnifiedDecisionService } from '../../../src/modules/intelligence/unified-decision.service.js';

const window = {
  current: { from: '2026-09-01', to: '2026-09-30' },
  comparison: { from: '2026-08-02', to: '2026-08-31' },
  days: 30,
};

function entityPage() {
  return { items: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } };
}

function product(overrides: Record<string, unknown> = {}) {
  return {
    product: { id: 'product-1', shopifyProductId: '100', title: 'Hero Product' },
    mapping: { confidence: 1, merchantConfirmed: true, limitations: [] },
    current: {
      commerce: { evidenceAvailable: true, netProductRevenue: 500, contributionBeforeAds: 250 },
      advertising: { spend: 0, byProvider: [] },
      storefront: {
        available: true,
        metrics: { productViewSessions: 100, viewToCartRate: 0.05, checkoutAbandonmentRate: 0.3 },
      },
      inventory: { state: 'HEALTHY', available: 50, daysCover: 30 },
      intelligence: {
        contributionAfterAds: 250,
        inefficientPaidDemand: false,
        profitableDemand: null,
        confidence: 'HIGH',
        limitations: [],
      },
      ...overrides,
    },
  };
}

function service(
  input: { quality?: unknown[]; products?: unknown[]; historyComplete?: boolean } = {},
) {
  const advertising = {
    read: vi.fn().mockResolvedValue({
      truthModel: {},
      filters: { provider: 'ALL', accountId: null, currency: null },
      window,
      dataQuality: {
        confidence: 'HIGH',
        items: input.quality ?? [],
      },
    }),
  };
  const entities = { list: vi.fn().mockResolvedValue(entityPage()) };
  const products = {
    list: vi.fn().mockResolvedValue({
      items: input.products ?? [],
      pagination: { page: 1, limit: 100, total: input.products?.length ?? 0, totalPages: 1 },
    }),
  };
  const lifecycle = {
    attach: vi.fn().mockImplementation(async (_storeId: string, drafts: unknown[]) => drafts),
  };
  const context = {
    getContext: vi.fn().mockResolvedValue({
      shopifyConnection: { status: 'ACTIVE' },
      successfulOrderHistorySync:
        input.historyComplete === false ? null : { status: 'SUCCEEDED' },
    }),
  };
  return new UnifiedDecisionService(
    advertising as never,
    entities as never,
    products as never,
    lifecycle as never,
    context as never,
  );
}

describe('UnifiedDecisionService guardrails', () => {
  it('keeps unsupported deduplicated reach as a limitation instead of an impossible action', async () => {
    const value = service({
      quality: [
        {
          code: 'UNAVAILABLE_REACH',
          status: 'WARNING',
          surface: 'PAID_MEDIA',
          message: 'Deduplicated period reach is unavailable.',
        },
      ],
    });
    const result = await value.read('store-1', { provider: 'ALL', days: 30 });
    expect(result.recommendations).toEqual([]);
    expect(result.dataQuality.items[0]).toMatchObject({ code: 'UNAVAILABLE_REACH' });
  });

  it('does not call a weak product page a paid-media correlation when mapped spend is zero', async () => {
    const value = service({ products: [product()] });
    const result = await value.read('store-1', { provider: 'ALL', days: 30 });
    expect(result.recommendations.map((item) => item.ruleId)).not.toContain(
      'unified_paid_product_weak_view_to_cart',
    );
    expect(result.recommendations.map((item) => item.ruleId)).toContain(
      'unified_profitable_product_low_paid_support',
    );
  });

  it('labels paid-media plus weak Pixel funnel evidence as correlation and blocks scaling on stock risk', async () => {
    const paid = product({
      advertising: { spend: 120, byProvider: [{ provider: 'META', spend: 120 }] },
      inventory: { state: 'STOCKOUT_RISK', available: 4, daysCover: 2 },
      intelligence: {
        contributionAfterAds: 130,
        inefficientPaidDemand: false,
        profitableDemand: true,
        confidence: 'HIGH',
        limitations: [],
      },
    });
    const value = service({ products: [paid] });
    const result = await value.read('store-1', { provider: 'ALL', days: 30 });
    const ids = result.recommendations.map((item) => item.ruleId);
    expect(ids).toContain('unified_inventory_paid_spend_conflict');
    expect(ids).toContain('unified_paid_product_weak_view_to_cart');
    expect(
      result.recommendations.find((item) => item.ruleId === 'unified_paid_product_weak_view_to_cart')
        ?.limitations,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'CORRELATION_NOT_CAUSATION' }),
      ]),
    );
  });

  it('fails commerce-derived decisions closed while preserving independently valid Pixel recommendations', async () => {
    const paid = product({
      commerce: {
        evidenceAvailable: false,
        netProductRevenue: 500,
        contributionBeforeAds: 250,
      },
      advertising: { spend: 120, byProvider: [{ provider: 'TIKTOK', spend: 120 }] },
      inventory: { state: 'OVERSTOCK_WEAK_DEMAND', available: 100, daysCover: null },
      intelligence: {
        contributionAfterAds: -10,
        inefficientPaidDemand: true,
        profitableDemand: false,
        confidence: 'LOW',
        limitations: ['INCOMPLETE_COMMERCE_HISTORY'],
      },
    });
    const organic = {
      ...product({
        commerce: {
          evidenceAvailable: false,
          netProductRevenue: 500,
          contributionBeforeAds: 250,
        },
        intelligence: {
          contributionAfterAds: null,
          inefficientPaidDemand: null,
          profitableDemand: null,
          confidence: 'LOW',
          limitations: ['INCOMPLETE_COMMERCE_HISTORY'],
        },
      }),
      product: { id: 'product-2', shopifyProductId: '200', title: 'Organic Product' },
    };
    const value = service({ historyComplete: false, products: [paid, organic] });
    const result = await value.read('store-1', { provider: 'ALL', days: 30 });
    const ids = result.recommendations.map((item) => item.ruleId);

    expect(ids).not.toContain('unified_inventory_overstock_weak_demand');
    expect(ids).not.toContain('unified_product_paid_demand_negative_contribution');
    expect(ids).not.toContain('unified_profitable_product_low_paid_support');
    expect(ids).toContain('unified_paid_product_weak_view_to_cart');
    expect(result.dataQuality.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INCOMPLETE_COMMERCE_HISTORY',
          status: 'BLOCKED',
          surface: 'COMMERCE',
        }),
      ]),
    );
    expect(result.dataQuality.confidence).toBe('LOW');
  });
});
