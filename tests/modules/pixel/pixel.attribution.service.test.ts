import { describe, expect, it, vi } from 'vitest';
import type { PixelAttributionRepository } from '../../../src/modules/pixel/attribution/pixel-attribution.repository.js';
import { PixelAttributionService } from '../../../src/modules/pixel/attribution/pixel-attribution.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const adAId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const adBId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const productId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const orderId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const visitorId = 'visitor_abcdefgh';

function repositoryMock() {
  return {
    getStoreContext: vi.fn(),
    findDirtyStoreIds: vi.fn().mockResolvedValue([]),
    withStoreRollupLock: vi.fn(async (_storeId: string, work: () => Promise<unknown>) => work()),
    findDirtySessions: vi.fn().mockResolvedValue([]),
    findLaterPurchaseSessions: vi.fn().mockResolvedValue([]),
    findSessionsForWindow: vi.fn(),
    findVisitorJourneySessions: vi.fn(),
    findValidOrders: vi.fn(),
    replaceDailyRows: vi.fn().mockResolvedValue({ attribution: 0, paths: 0, targets: 0 }),
    acknowledgeSessions: vi.fn().mockResolvedValue(1),
    advanceRollupState: vi.fn(),
    recordRollupError: vi.fn(),
    groupAttribution: vi.fn().mockResolvedValue([]),
    groupAttributionKeys: vi.fn().mockResolvedValue([]),
    countAttributionKeys: vi.fn().mockResolvedValue(0),
    findAttributionMetadata: vi.fn().mockResolvedValue([]),
    groupPaths: vi.fn().mockResolvedValue([]),
    groupPathHashes: vi.fn().mockResolvedValue([]),
    countPaths: vi.fn().mockResolvedValue(0),
    groupTargetEvidence: vi.fn().mockResolvedValue([]),
    groupTargetEvidenceForAds: vi.fn().mockResolvedValue([]),
    countTargetEvidence: vi.fn().mockResolvedValue(0),
    findTargetMetadata: vi.fn().mockResolvedValue([]),
    findMetaAdsForDisplay: vi.fn().mockResolvedValue([]),
    findProductsForDisplay: vi.fn().mockResolvedValue([]),
    findCollectionsForDisplay: vi.fn().mockResolvedValue([]),
    findActiveMappings: vi.fn().mockResolvedValue({ products: [], collections: [] }),
  } as unknown as PixelAttributionRepository;
}

function metaTouch(input: {
  ordinal: number;
  eventAt: string;
  adId: string;
  externalId: string;
}) {
  return {
    ordinal: input.ordinal,
    eventAt: new Date(input.eventAt),
    source: 'META' as const,
    metaCampaignId: '11111111-1111-4111-8111-111111111111',
    metaAdSetId: '22222222-2222-4222-8222-222222222222',
    metaAdId: input.adId,
    metaCampaignExternalId: '100',
    metaAdSetExternalId: '200',
    metaAdExternalId: input.externalId,
    metaResolutionStatus: 'EXACT' as const,
  };
}

function validOrder() {
  return {
    id: orderId,
    lineItems: [
      {
        productId,
        variantId: null,
        shopifyProductId: 'gid://shopify/Product/1000',
        shopifyVariantId: null,
      },
    ],
  };
}

function productInteraction() {
  return {
    identityKey: 'product-1',
    productId,
    variantId: null,
    shopifyProductExternalId: 'gid://shopify/Product/1000',
    shopifyVariantExternalId: null,
    resolutionStatus: 'EXACT' as const,
    viewCount: 1,
    addToCartCount: 1,
  };
}

describe('PixelAttributionService', () => {
  it('preserves Ad A assist -> Ad B last-touch evidence across first-party sessions', async () => {
    const repository = repositoryMock();
    const currentSession = {
      id: 'session-b',
      anonymousVisitorId: visitorId,
      startedAt: new Date('2026-09-04T14:00:00.000Z'),
      endedAt: new Date('2026-09-04T14:10:00.000Z'),
      checkoutCompletedAt: new Date('2026-09-04T14:10:00.000Z'),
      orderId,
      orderLinkStatus: 'LINKED' as const,
      touches: [metaTouch({ ordinal: 1, eventAt: '2026-09-04T14:00:00.000Z', adId: adBId, externalId: '301' })],
      products: [productInteraction()],
      collections: [],
    };
    vi.mocked(repository.findSessionsForWindow)
      .mockResolvedValueOnce([currentSession] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(repository.findValidOrders).mockResolvedValue([validOrder()] as never);
    vi.mocked(repository.findVisitorJourneySessions).mockResolvedValue([
      {
        id: 'session-a',
        startedAt: new Date('2026-09-02T12:00:00.000Z'),
        touches: [metaTouch({ ordinal: 1, eventAt: '2026-09-02T12:00:00.000Z', adId: adAId, externalId: '300' })],
      },
      { id: 'session-b', startedAt: currentSession.startedAt, touches: currentSession.touches },
    ] as never);

    const service = new PixelAttributionService(repository, () => new Date('2026-09-05T00:00:00.000Z'));
    await service.rebuildStoreDate(storeId, 'UTC', '2026-09-04');

    const [, , attribution, paths, targets] = vi.mocked(repository.replaceDailyRows).mock.calls[0]!;
    const adA = attribution.find((row) => row.metaAdId === adAId)!;
    const adB = attribution.find((row) => row.metaAdId === adBId)!;

    expect(adA).toMatchObject({
      linkedPurchaseSessionCount: 1,
      firstTouchPurchaseSessionCount: 1,
      assistedPurchaseSessionCount: 1,
      lastTouchPurchaseSessionCount: 0,
      crossSessionPurchaseCount: 1,
    });
    expect(adB).toMatchObject({
      linkedPurchaseSessionCount: 1,
      firstTouchPurchaseSessionCount: 0,
      lastTouchPurchaseSessionCount: 1,
      crossSessionPurchaseCount: 1,
    });
    expect(paths).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: 'JOURNEY:META', linkedPurchaseSessionCount: 1, crossSessionPurchaseCount: 1 }),
    ]));
    expect(targets).toEqual(expect.arrayContaining([
      expect.objectContaining({
        metaAdId: adBId,
        targetType: 'PRODUCT',
        productId,
        linkedPurchaseSessionCount: 1,
        lastTouchPurchaseSessionCount: 1,
      }),
    ]));
    expect(targets.some((row) => row.metaAdId === adAId)).toBe(false);
    expect(repository.acknowledgeSessions).not.toHaveBeenCalled();
  });

  it('excludes post-checkout touches from purchase credit and keeps a coherent session denominator', async () => {
    const repository = repositoryMock();
    const prePurchase = metaTouch({ ordinal: 1, eventAt: '2026-09-04T14:00:00.000Z', adId: adBId, externalId: '301' });
    const postPurchase = metaTouch({ ordinal: 2, eventAt: '2026-09-04T14:15:00.000Z', adId: adAId, externalId: '302' });
    const currentSession = {
      id: 'session-cutoff',
      anonymousVisitorId: visitorId,
      startedAt: new Date('2026-09-04T14:00:00.000Z'),
      endedAt: new Date('2026-09-04T14:20:00.000Z'),
      checkoutCompletedAt: new Date('2026-09-04T14:10:00.000Z'),
      orderId,
      orderLinkStatus: 'LINKED' as const,
      touches: [prePurchase, postPurchase],
      products: [productInteraction()],
      collections: [],
    };
    vi.mocked(repository.findSessionsForWindow)
      .mockResolvedValueOnce([currentSession] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(repository.findValidOrders).mockResolvedValue([validOrder()] as never);
    vi.mocked(repository.findVisitorJourneySessions).mockResolvedValue([
      { id: currentSession.id, startedAt: currentSession.startedAt, touches: currentSession.touches },
    ] as never);

    const service = new PixelAttributionService(repository, () => new Date('2026-09-05T00:00:00.000Z'));
    await service.rebuildStoreDate(storeId, 'UTC', '2026-09-04');

    const [, , attribution, paths, targets] = vi.mocked(repository.replaceDailyRows).mock.calls[0]!;
    const prePurchaseAd = attribution.find((row) => row.metaAdId === adBId)!;
    const postPurchaseAd = attribution.find((row) => row.metaAdId === adAId)!;
    const sessionPath = paths.find((row) => row.path === 'SESSION:META')!;
    const journeyPath = paths.find((row) => row.path === 'JOURNEY:META')!;
    const postPurchaseTarget = targets.find((row) => row.metaAdId === adAId)!;

    expect(prePurchaseAd).toMatchObject({ linkedPurchaseSessionCount: 1, lastTouchPurchaseSessionCount: 1 });
    expect(postPurchaseAd).toMatchObject({
      touchedSessionCount: 1,
      linkedPurchaseSessionCount: 0,
      firstTouchPurchaseSessionCount: 0,
      lastTouchPurchaseSessionCount: 0,
      assistedPurchaseSessionCount: 0,
    });
    expect(sessionPath).toMatchObject({ sessionCount: 1, linkedPurchaseSessionCount: 1 });
    expect(journeyPath).toMatchObject({ sessionCount: 0, linkedPurchaseSessionCount: 1 });
    expect(postPurchaseTarget.linkedPurchaseSessionCount).toBe(0);
  });

  it('rebuilds downstream dates for old and new visitor/start identities before acknowledging', async () => {
    const repository = repositoryMock();
    const acknowledgedAt = new Date('2026-09-05T01:00:00.000Z');
    const orderUpdatedAt = new Date('2026-09-05T00:59:00.000Z');
    const oldVisitor = 'visitor_old_abcdefgh';
    const dirty = {
      id: 'session-selected',
      startedAt: new Date('2026-09-04T10:00:00.000Z'),
      previousStartedAt: new Date('2026-09-02T10:00:00.000Z'),
      rollupDirtyAt: acknowledgedAt,
      orderUpdatedAt,
      dirtyAt: acknowledgedAt,
      anonymousVisitorId: visitorId,
      visitorIds: [oldVisitor, visitorId],
    };
    vi.mocked(repository.findDirtyStoreIds).mockResolvedValue([storeId]);
    vi.mocked(repository.getStoreContext).mockResolvedValue({
      id: storeId,
      ianaTimezone: 'UTC',
      pixelInstallation: { status: 'ACTIVE', lastEventAt: acknowledgedAt },
      storefrontAttributionRollup: null,
    } as never);
    vi.mocked(repository.findDirtySessions).mockResolvedValue([dirty] as never);
    vi.mocked(repository.findLaterPurchaseSessions).mockResolvedValue([
      { startedAt: new Date('2026-09-05T12:00:00.000Z') },
    ] as never);
    const service = new PixelAttributionService(repository, () => acknowledgedAt);
    const rebuild = vi.spyOn(service, 'rebuildStoreDate').mockResolvedValue({ attribution: 0, paths: 0, targets: 0 });

    await service.rollupDirtyStores();

    expect(repository.findLaterPurchaseSessions).toHaveBeenCalledWith(
      storeId,
      expect.arrayContaining([oldVisitor, visitorId]),
      dirty.previousStartedAt,
      new Date(dirty.startedAt.getTime() + 30 * 86_400_000),
    );
    expect(rebuild.mock.calls.map((call) => call[2])).toEqual(['2026-09-02', '2026-09-04', '2026-09-05']);
    expect(repository.acknowledgeSessions).toHaveBeenCalledWith(storeId, [dirty], acknowledgedAt);
    expect(repository.withStoreRollupLock).toHaveBeenCalledWith(storeId, expect.any(Function));
  });

  it('caps Pixel-only mapping suggestions below the exact mapping threshold and never activates them', async () => {
    const repository = repositoryMock();
    vi.mocked(repository.getStoreContext).mockResolvedValue({
      id: storeId,
      ianaTimezone: 'UTC',
      pixelInstallation: { status: 'ACTIVE', lastEventAt: new Date('2026-09-04T20:00:00.000Z') },
      storefrontAttributionRollup: {
        rolledThroughSessionUpdatedAt: new Date('2026-09-04T20:00:01.000Z'),
        lastRolledUpAt: new Date('2026-09-04T20:00:02.000Z'),
        lastError: null,
      },
    } as never);
    const targetEvidence = {
      metaAdId: adBId,
      targetKey: `product:${productId}`,
      _sum: {
        interactedSessionCount: 20,
        viewedSessionCount: 18,
        addToCartSessionCount: 8,
        linkedPurchaseSessionCount: 5,
        firstTouchPurchaseSessionCount: 2,
        lastTouchPurchaseSessionCount: 4,
        assistedPurchaseSessionCount: 2,
      },
    };
    vi.mocked(repository.groupTargetEvidence).mockResolvedValue([targetEvidence] as never);
    vi.mocked(repository.groupTargetEvidenceForAds).mockResolvedValue([targetEvidence] as never);
    vi.mocked(repository.countTargetEvidence).mockResolvedValue(1);
    vi.mocked(repository.findTargetMetadata).mockResolvedValue([
      {
        metaAdId: adBId,
        metaAdExternalId: '301',
        targetType: 'PRODUCT',
        targetKey: `product:${productId}`,
        productId,
        collectionId: null,
        productExternalId: 'gid://shopify/Product/1000',
        variantExternalId: null,
        collectionExternalId: null,
      },
    ] as never);
    vi.mocked(repository.findMetaAdsForDisplay).mockResolvedValue([
      {
        id: adBId,
        metaAdId: '301',
        name: 'Ad B',
        targetScope: 'UNKNOWN',
        targetScopeConfidence: null,
        effectiveStatus: 'ACTIVE',
      },
    ] as never);
    vi.mocked(repository.findProductsForDisplay).mockResolvedValue([
      {
        id: productId,
        shopifyProductId: 'gid://shopify/Product/1000',
        title: 'Shoe',
        handle: 'shoe',
        deletedAt: null,
      },
    ] as never);

    const service = new PixelAttributionService(repository, () => new Date('2026-09-05T12:00:00.000Z'));
    const result = await service.mappingEvidence(storeId, 'PRODUCT', { days: 1, page: 1, limit: 50 });

    expect(result.items[0]!.suggestion).toMatchObject({
      status: 'REVIEW_SUGGESTION',
      automaticallyActivatesMapping: false,
      exactMappingThreshold: 0.7,
    });
    expect(result.items[0]!.suggestion.suggestedConfidence).toBeLessThanOrEqual(0.69);
    expect(result.thresholds.maximumPixelOnlySuggestedConfidence).toBe(0.69);
  });
});