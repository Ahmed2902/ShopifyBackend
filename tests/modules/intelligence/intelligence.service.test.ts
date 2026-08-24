import { describe, expect, it, vi } from 'vitest';
import { IntelligenceRepository } from '../../../src/modules/intelligence/intelligence.repository.js';
import { IntelligenceService } from '../../../src/modules/intelligence/intelligence.service.js';
import type { IntelligenceDataset, ProductSignal } from '../../../src/modules/intelligence/intelligence.types.js';

const provider = {
  provider: 'META' as const,
  currency: 'USD',
  ads: 1,
  activeAds: 1,
  spend: 100,
  impressions: 5000,
  clicks: 200,
  conversions: 10,
  conversionValue: 350,
  roas: 3.5,
};

function product(overrides: Partial<ProductSignal> = {}): ProductSignal {
  return {
    productId: '11111111-1111-4111-8111-111111111111',
    title: 'Trail Pro',
    status: 'ACTIVE',
    tracksInventory: true,
    available: 300,
    incoming: 0,
    nextRestockAt: null,
    unitsSold: 70,
    orderCount: 30,
    mappingConfidence: 0.95,
    mappingConfirmed: true,
    sharedAdMapping: false,
    providers: [provider],
    ...overrides,
  };
}

function serviceWith(products: ProductSignal[]) {
  const dataset: IntelligenceDataset = {
    connections: { shopify: 'ACTIVE', meta: 'ACTIVE', tiktok: 'ACTIVE' },
    products,
  };
  const repository = { load: vi.fn().mockResolvedValue(dataset) } as unknown as IntelligenceRepository;
  return new IntelligenceService(repository);
}

describe('IntelligenceService', () => {
  it('scales efficient mapped demand when stock runway is healthy', async () => {
    const result = await serviceWith([product()]).getRecommendations('store-id', { lookbackDays: 14, limit: 50 });
    expect(result.recommendations[0]?.decision).toBe('SCALE');
    expect(result.recommendations[0]?.evidence.paid.roas).toBe(3.5);
    expect(result.recommendations[0]?.evidence.paid.currency).toBe('USD');
    expect(result.engine.automaticMutations).toBe(false);
  });

  it('pauses paid pressure when tracked inventory is out', async () => {
    const result = await serviceWith([product({ available: 0 })]).getRecommendations('store-id', { lookbackDays: 14, limit: 50 });
    expect(result.recommendations[0]?.decision).toBe('PAUSE');
  });

  it('asks for more data when one ad is shared across multiple product mappings', async () => {
    const result = await serviceWith([product({ sharedAdMapping: true })]).getRecommendations('store-id', { lookbackDays: 14, limit: 50 });
    expect(result.recommendations[0]?.decision).toBe('MORE_DATA');
    expect(result.recommendations[0]?.reasons.join(' ')).toMatch(/multiple products/i);
  });

  it('does not aggregate monetary performance across currencies', async () => {
    const result = await serviceWith([
      product({
        providers: [
          provider,
          { ...provider, provider: 'TIKTOK', currency: 'EGP', spend: 3000, conversionValue: 12000, roas: 4 },
        ],
      }),
    ]).getRecommendations('store-id', { lookbackDays: 14, limit: 50 });
    expect(result.recommendations[0]?.decision).toBe('MORE_DATA');
    expect(result.recommendations[0]?.evidence.paid.currencyCompatible).toBe(false);
    expect(result.recommendations[0]?.evidence.paid.spend).toBeNull();
  });

  it('can scope the decision response to one product', async () => {
    const targetId = '22222222-2222-4222-8222-222222222222';
    const result = await serviceWith([
      product(),
      product({ productId: targetId, title: 'Cloud Runner' }),
    ]).getRecommendations('store-id', { lookbackDays: 14, limit: 50, productId: targetId });
    expect(result.readiness.joinedProducts).toBe(1);
    expect(result.recommendations).toHaveLength(1);
    expect(result.recommendations[0]?.product.id).toBe(targetId);
  });
});
