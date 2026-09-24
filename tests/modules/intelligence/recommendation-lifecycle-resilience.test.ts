import { beforeEach, describe, expect, it, vi } from 'vitest';

const recommendationLifecycle = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
}));
const advertisingCampaign = vi.hoisted(() => ({ findMany: vi.fn() }));
const advertisingGroup = vi.hoisted(() => ({ findMany: vi.fn() }));
const advertisingAd = vi.hoisted(() => ({ findMany: vi.fn() }));
const advertisingCreative = vi.hoisted(() => ({ findMany: vi.fn() }));
const product = vi.hoisted(() => ({ findMany: vi.fn() }));
const collection = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    recommendationLifecycle,
    advertisingCampaign,
    advertisingGroup,
    advertisingAd,
    advertisingCreative,
    product,
    collection,
  },
}));

import { RecommendationLifecycleService } from '../../../src/modules/intelligence/recommendation-lifecycle.service.js';
import type { RecommendationDraft } from '../../../src/modules/intelligence/intelligence.types.js';

function recommendation(overrides: Partial<RecommendationDraft> = {}): RecommendationDraft & { priority: number } {
  return {
    ruleId: 'campaign_efficiency_deterioration',
    ruleVersion: '2',
    category: 'CAMPAIGN_EFFICIENCY',
    severity: 'HIGH',
    entityType: 'CAMPAIGN',
    entityId: '11111111-1111-4111-8111-111111111111',
    externalEntityId: 'meta-campaign-1',
    title: 'Campaign efficiency weakened while spend increased',
    summary: 'Observed deterioration.',
    suggestedAction: 'Review delivery.',
    impactScore: 0.8,
    confidenceScore: 0.9,
    urgencyScore: 0.8,
    evidenceQuality: 'HIGH',
    attributionPrecision: 'META_PROVIDER',
    limitations: [],
    observationStart: new Date('2026-09-11T00:00:00.000Z'),
    observationEnd: new Date('2026-09-17T00:00:00.000Z'),
    comparisonStart: new Date('2026-09-04T00:00:00.000Z'),
    comparisonEnd: new Date('2026-09-10T00:00:00.000Z'),
    evidence: {},
    priority: 0.576,
    ...overrides,
  };
}

describe('RecommendationLifecycleService resilience', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recommendationLifecycle.findMany.mockResolvedValue([]);
    recommendationLifecycle.upsert.mockResolvedValue({});
    advertisingCampaign.findMany.mockResolvedValue([]);
    advertisingGroup.findMany.mockResolvedValue([]);
    advertisingAd.findMany.mockResolvedValue([]);
    advertisingCreative.findMany.mockResolvedValue([]);
    product.findMany.mockResolvedValue([]);
    collection.findMany.mockResolvedValue([]);
  });

  it('keeps the decision feed readable when the lifecycle table has not been migrated locally', async () => {
    recommendationLifecycle.findMany.mockRejectedValue({ code: 'P2021' });
    advertisingCampaign.findMany.mockResolvedValue([
      { id: '11111111-1111-4111-8111-111111111111', name: 'Prospecting · Cairo · September' },
    ]);

    const result = await new RecommendationLifecycleService().attach('store-1', [recommendation()]);

    expect(result).toHaveLength(1);
    expect(result[0]?.lifecycleState).toBe('OPEN');
    expect(result[0]?.entityName).toBe('Prospecting · Cairo · September');
    expect(result[0]?.occurrenceKey).toContain('campaign_efficiency_deterioration');
    expect(advertisingCampaign.findMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['11111111-1111-4111-8111-111111111111'] },
        account: { storeId: 'store-1' },
      },
      select: { id: true, name: true },
    });
  });

  it('still surfaces an explicit service error when a lifecycle write cannot be persisted', async () => {
    recommendationLifecycle.upsert.mockRejectedValue({ code: 'P2022' });
    const current = recommendation();
    const attached = await new RecommendationLifecycleService().attach('store-1', [current]);

    await expect(
      new RecommendationLifecycleService().setState(
        'store-1',
        attached[0]!.occurrenceKey,
        'REVIEWED',
        [current],
      ),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'RECOMMENDATION_LIFECYCLE_UNAVAILABLE',
    });
  });
});