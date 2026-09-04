import { describe, expect, it } from 'vitest';
import {
  aggregateVariantUnits,
  metricChanges,
} from '../../../src/modules/analytics/analytics.metrics.js';

describe('analytics metrics', () => {
  it('counts non-restocked refunds as inventory depletion', () => {
    const units = aggregateVariantUnits([
      {
        variantId: 'variant-1',
        quantity: 10,
        refundLines: [
          { quantity: 2, restocked: true },
          { quantity: 3, restocked: false },
        ],
      },
    ]);

    expect(units.get('variant-1')).toBe(8);
  });

  it('keeps relative change undefined when the comparison baseline is zero', () => {
    expect(
      metricChanges(
        { spend: 100, roas: 2 },
        { spend: 0, roas: 1 },
      ),
    ).toEqual({ spend: null, roas: 1 });
  });
});
