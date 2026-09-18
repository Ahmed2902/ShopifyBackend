import { describe, expect, it } from 'vitest';
import { providerFirstPartyPurchaseGapRule } from '../../../src/modules/intelligence/attribution-intelligence.rules.js';

const window = {
  observationStart: new Date('2026-09-01T00:00:00.000Z'),
  observationEnd: new Date('2026-09-07T23:59:59.999Z'),
};

describe('provider vs first-party attribution health', () => {
  it('flags a material supported discrepancy without calling either model wrong', () => {
    const result = providerFirstPartyPurchaseGapRule({
      providerPurchases: 40,
      firstPartyMetaPurchaseJourneys: 20,
      metaTouchedSessions: 1_200,
      attributionQuality: 'READY',
      ...window,
    });

    expect(result).toMatchObject({
      ruleId: 'provider_first_party_purchase_gap',
      category: 'ATTRIBUTION_HEALTH',
      entityType: 'STORE',
      severity: 'HIGH',
      attributionPrecision: 'STORE',
    });
    expect(result?.limitations).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'ATTRIBUTION_MODELS_DIFFER' })]),
    );
    expect(result?.evidence).toMatchObject({
      interpretation: 'ATTRIBUTION_MODEL_DISCREPANCY_NOT_PROVIDER_ERROR',
      relativeGap: 0.5,
    });
  });

  it('suppresses the signal when first-party attribution quality is not ready', () => {
    expect(
      providerFirstPartyPurchaseGapRule({
        providerPurchases: 100,
        firstPartyMetaPurchaseJourneys: 10,
        metaTouchedSessions: 2_000,
        attributionQuality: 'DEGRADED',
        ...window,
      }),
    ).toBeNull();
  });

  it('suppresses small attribution-model differences', () => {
    expect(
      providerFirstPartyPurchaseGapRule({
        providerPurchases: 40,
        firstPartyMetaPurchaseJourneys: 32,
        metaTouchedSessions: 1_200,
        attributionQuality: 'READY',
        ...window,
      }),
    ).toBeNull();
  });
});
