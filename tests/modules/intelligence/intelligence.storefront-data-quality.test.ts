import { describe, expect, it, vi } from 'vitest';
import type { IntelligenceCommerceReadRepository } from '../../../src/modules/intelligence/intelligence-commerce.read.repository.js';
import type { IntelligenceContextReadRepository } from '../../../src/modules/intelligence/intelligence-context.read.repository.js';
import type { IntelligenceRepository } from '../../../src/modules/intelligence/intelligence.repository.js';
import type { IntelligenceSharedExposureReadRepository } from '../../../src/modules/intelligence/intelligence-shared-exposure.read.repository.js';
import type { IntelligenceStorefrontReadRepository } from '../../../src/modules/intelligence/intelligence-storefront.read.repository.js';
import { IntelligenceService } from '../../../src/modules/intelligence/intelligence.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-14T12:00:00.000Z');

describe('IntelligenceService storefront comparison quality', () => {
  it('warns when comparison rows exist but the current storefront period is missing', async () => {
    const repository = {
      getMetaEvidenceRows: vi.fn().mockResolvedValue([]),
      getActiveProductMappings: vi.fn().mockResolvedValue([]),
      getSettings: vi.fn(),
      updateInventoryMode: vi.fn(),
    } as unknown as IntelligenceRepository;
    const commerce = {
      getProductEvidenceAggregates: vi.fn().mockResolvedValue([]),
      getInventoryEvidenceAggregates: vi.fn().mockResolvedValue([]),
    } as unknown as IntelligenceCommerceReadRepository;
    const shared = {
      getTargets: vi.fn().mockResolvedValue([]),
    } as unknown as IntelligenceSharedExposureReadRepository;
    const context = {
      getContext: vi.fn().mockResolvedValue({
        id: storeId,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
        inventoryIntelligenceMode: 'DISABLED',
        inventoryReviewedAt: null,
        shopifyConnection: {
          status: 'ACTIVE',
          scopes: ['read_orders', 'read_all_orders'],
          lastSyncedAt: now,
        },
        metaConnection: null,
        successfulOrderHistorySync: null,
        latestMetaInsightSyncedAt: null,
        pixelInstallation: { status: 'ACTIVE', lastEventAt: now },
        storefrontBehaviorRollup: { lastRolledUpAt: now, lastError: null },
      }),
    } as unknown as IntelligenceContextReadRepository;
    const storefront = {
      getEvidence: vi.fn().mockResolvedValue([
        {
          period: 'COMPARISON',
          dimension: 'STORE',
          dimensionKey: 'store',
          productId: null,
          productExternalId: null,
          productTitle: null,
          landingPageUrl: null,
          sourceRowCount: 7,
          sessionCount: 100,
          productViewSessionCount: 70,
          addToCartSessionCount: 20,
          cartViewSessionCount: 15,
          cartViewCheckoutSessionCount: 10,
          cartViewPurchaseSessionCount: 5,
          checkoutStartSessionCount: 10,
          checkoutStartPurchaseSessionCount: 5,
          checkoutCompletedSessionCount: 6,
          linkedPurchaseSessionCount: 5,
        },
      ]),
    } as unknown as IntelligenceStorefrontReadRepository;

    const snapshot = await new IntelligenceService(
      repository,
      commerce,
      shared,
      context,
      storefront,
    ).snapshot(storeId, now);

    expect(snapshot.evidence).toMatchObject({
      storefrontCurrentRows: 0,
      storefrontComparisonRows: 7,
    });
    expect(snapshot.dataQuality).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'PIXEL_BEHAVIOR_MISSING',
          status: 'WARNING',
          metrics: { currentRows: 0, comparisonRows: 7 },
        }),
      ]),
    );
    expect(snapshot.dataQuality).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'CORE_DATA_HEALTHY' })]),
    );
  });
});
