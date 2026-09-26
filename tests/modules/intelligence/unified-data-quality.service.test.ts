import { describe, expect, it, vi } from 'vitest';
import { UnifiedDataQualityService } from '../../../src/modules/intelligence/unified-data-quality.service.js';

const window = {
  current: { from: '2026-09-01', to: '2026-09-30' },
  comparison: { from: '2026-08-02', to: '2026-08-31' },
  days: 30,
};

function entityPage(input: { low?: boolean; total?: number } = {}) {
  return {
    items: input.low
      ? [
          {
            intelligence: {
              confidence: 'LOW',
              signals: [{ code: 'LOW_DELIVERY_INSUFFICIENT_EVIDENCE' }],
              limitations: [],
            },
          },
        ]
      : [],
    pagination: {
      page: 1,
      limit: 100,
      total: input.total ?? (input.low ? 1 : 0),
      totalPages: 1,
    },
  };
}

function createService(input: {
  pixelStatus?: string;
  orderHistory?: boolean;
  ambiguousSpend?: number;
  unmappedSpend?: number;
  google?: boolean;
  lowSample?: boolean;
  totalCampaigns?: number;
} = {}) {
  const advertising = {
    read: vi.fn().mockResolvedValue({
      schemaVersion: '2.0',
      filters: { provider: 'ALL', accountId: null, currency: null },
      window,
      accounts: input.google ? [{ id: 'google-1', provider: 'GOOGLE_ADS' }] : [],
      dataQuality: {
        confidence: 'HIGH',
        items: [
          {
            code: 'UNAVAILABLE_REACH',
            status: 'WARNING',
            surface: 'PAID_MEDIA',
            message: 'Unavailable.',
          },
        ],
      },
      capabilities: { reach: { available: false } },
    }),
  };
  const productAds = {
    list: vi.fn().mockResolvedValue({
      summary: {
        current: {
          ambiguousObservedSpend: input.ambiguousSpend ?? 0,
          unmappedSpend: input.unmappedSpend ?? 0,
          mappingCoverage: 0.5,
        },
      },
      pagination: { page: 1, limit: 100, total: 1, totalPages: 1 },
    }),
  };
  const paidEntities = {
    list: vi.fn().mockImplementation(async (_storeId: string, kind: string) =>
      entityPage({
        low: input.lowSample && kind === 'CAMPAIGN',
        total: kind === 'CAMPAIGN' ? input.totalCampaigns : undefined,
      }),
    ),
  };
  const pixel = {
    read: vi.fn().mockResolvedValue({
      installation: {
        status: input.pixelStatus ?? 'ACTIVE',
        lastEventAt: new Date('2026-09-23T10:00:00.000Z'),
      },
      behaviorRollup: { lastError: null },
      attributionRollup: { lastError: null },
    }),
  };
  const context = {
    getContext: vi.fn().mockResolvedValue({
      successfulOrderHistorySync: input.orderHistory === false ? null : { status: 'SUCCEEDED' },
    }),
  };
  return new UnifiedDataQualityService(
    advertising as never,
    productAds as never,
    paidEntities as never,
    pixel as never,
    context as never,
  );
}

describe('UnifiedDataQualityService', () => {
  it('surfaces cross-source blockers and mapping limitations explicitly', async () => {
    const service = createService({
      pixelStatus: 'ERROR',
      orderHistory: false,
      ambiguousSpend: 25,
      unmappedSpend: 40,
      google: true,
      lowSample: true,
    });
    const result = await service.read(
      'store-1',
      { provider: 'ALL', days: 30 },
      new Date('2026-09-23T11:00:00.000Z'),
    );
    const codes = result.items.map((item) => item.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'UNAVAILABLE_REACH',
        'INCOMPLETE_COMMERCE_HISTORY',
        'PIXEL_UNAVAILABLE',
        'AMBIGUOUS_MAPPING',
        'MAPPING_GAP',
        'PMAX_PRODUCT_ALLOCATION_LIMITATION',
        'INSUFFICIENT_SAMPLE',
      ]),
    );
    expect(result.confidence).toBe('LOW');
    expect(result.capabilities.productAllocation.pmaxUnmappedWhenNoExactEvidence).toBe(true);
  });

  it('reports bounded quality evaluation instead of pretending full entity coverage', async () => {
    const service = createService({ totalCampaigns: 101 });
    const result = await service.read(
      'store-1',
      { provider: 'ALL', days: 30 },
      new Date('2026-09-23T11:00:00.000Z'),
    );
    expect(result.evaluationBounds).toMatchObject({ maxPerEntityType: 100, truncated: true });
    expect(result.items).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'QUALITY_AUDIT_BOUNDED' })]),
    );
    expect(result.confidence).toBe('MEDIUM');
  });

  it('does not lower confidence solely because deduplicated reach is unsupported', async () => {
    const service = createService();
    const result = await service.read(
      'store-1',
      { provider: 'ALL', days: 30 },
      new Date('2026-09-23T11:00:00.000Z'),
    );
    expect(result.items.map((item) => item.code)).toEqual(['UNAVAILABLE_REACH']);
    expect(result.confidence).toBe('HIGH');
  });
});