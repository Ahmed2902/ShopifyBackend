import { describe, expect, it, vi } from 'vitest';
import { PixelBehaviorOverviewReadService } from '../../../src/modules/pixel/behavior/pixel-behavior-overview.read.service.js';

const storeId = '11111111-1111-4111-8111-111111111111';

describe('PixelBehaviorOverviewReadService', () => {
  it('reuses the behavior overview and checkout overlap reads to produce shared derived understanding', async () => {
    const currentFrom = new Date('2026-09-01T04:00:00.000Z');
    const currentTo = new Date('2026-09-21T03:59:59.999Z');
    const comparisonFrom = new Date('2026-08-11T04:00:00.000Z');
    const comparisonTo = new Date('2026-09-01T03:59:59.999Z');
    const snapshotAt = new Date('2026-09-22T08:00:00.000Z');
    const behavior = {
      overview: vi.fn().mockResolvedValue({
        window: {
          current: { instantFrom: currentFrom, instantTo: currentTo },
          comparison: { instantFrom: comparisonFrom, instantTo: comparisonTo },
        },
        current: {
          sessions: 100,
          productViewSessions: 80,
          addToCartSessions: 40,
          cartViewSessions: 30,
          cartViewCheckoutSessions: 18,
          cartViewPurchaseSessions: 12,
          checkoutStartSessions: 20,
        },
        comparison: {
          sessions: 100,
          productViewSessions: 75,
          addToCartSessions: 45,
          cartViewSessions: 30,
          cartViewCheckoutSessions: 21,
          cartViewPurchaseSessions: 15,
          checkoutStartSessions: 20,
        },
        change: {},
        dataQuality: { state: 'READY' },
        methodology: { interpretation: 'Observed first-party behavior; no causal attribution is implied.' },
      }),
    };
    const checkout = {
      getOverlapCounts: vi.fn().mockResolvedValue({ current: 10, comparison: 14 }),
    };
    const service = new PixelBehaviorOverviewReadService(behavior as never, checkout as never);

    const result = await service.read(storeId, { days: 21 }, snapshotAt);

    expect(behavior.overview).toHaveBeenCalledWith(storeId, { days: 21 }, snapshotAt);
    expect(checkout.getOverlapCounts).toHaveBeenCalledWith({
      storeId,
      currentFrom,
      currentTo,
      comparisonFrom,
      comparisonTo,
    });
    expect(result.understanding.current).toMatchObject({
      cartAbandonmentRate: 0.6,
      checkoutCompletionRate: 0.5,
      checkoutAbandonmentRate: 0.5,
      checkoutStartPurchaseSessions: 10,
    });
    expect(result.understanding.comparison).toMatchObject({
      cartAbandonmentRate: 0.5,
      checkoutCompletionRate: 0.7,
      checkoutAbandonmentRate: 0.30000000000000004,
      checkoutStartPurchaseSessions: 14,
    });
    expect(result.understanding.changePoints).toMatchObject({
      cartAbandonmentRate: 0.09999999999999998,
      checkoutCompletionRate: -0.19999999999999996,
      checkoutAbandonmentRate: 0.19999999999999996,
    });
    expect(result.understanding.methodology.interpretation).toContain('no causal explanation');
  });
});
