import { describe, expect, it, vi } from 'vitest';
import type { PixelJourneyRepository } from '../../../src/modules/pixel/journey/pixel-journey.repository.js';
import { PixelJourneyService } from '../../../src/modules/pixel/journey/pixel-journey.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const browserSessionId = 'event_session_001';
const visitorId = 'visitor_abcdefgh';
const retention = new Date('2026-12-03T12:00:00.000Z');
const fixedNow = new Date('2026-09-04T15:00:00.000Z');

function event(input: Record<string, unknown>) {
  return {
    id: crypto.randomUUID(),
    eventId: crypto.randomUUID().replaceAll('-', '_'),
    eventName: 'PAGE_VIEW',
    eventAt: new Date('2026-09-04T10:00:00.000Z'),
    receivedAt: new Date('2026-09-04T10:00:01.000Z'),
    anonymousVisitorId: visitorId,
    pageUrl: 'https://shop.example/products/shoe',
    referrerUrl: null,
    landingPageUrl: 'https://shop.example/products/shoe',
    productExternalId: null,
    variantExternalId: null,
    collectionExternalId: null,
    quantity: null,
    shopifyCheckoutToken: null,
    shopifyOrderExternalId: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    metaClickId: null,
    googleClickId: null,
    tiktokClickId: null,
    metaCampaignExternalId: null,
    metaAdSetExternalId: null,
    metaAdExternalId: null,
    retentionExpiresAt: retention,
    ...input,
  };
}

function buildRepository(events: Array<Record<string, unknown>>) {
  return {
    findSessionEvents: vi.fn().mockResolvedValue(events),
    resolveMetaHierarchy: vi.fn().mockResolvedValue({ campaigns: [], adSets: [], ads: [] }),
    resolveCommerceEntities: vi.fn().mockResolvedValue({ products: [], variants: [], collections: [] }),
    findOrderByExternalId: vi.fn().mockResolvedValue(null),
    replaceSessionReadModel: vi.fn().mockResolvedValue({ id: 'session-db-id' }),
    findDirtySessionKeys: vi.fn().mockResolvedValue([]),
    findPendingOrderSessions: vi.fn().mockResolvedValue([]),
    setOrderLink: vi.fn().mockResolvedValue({ id: 'session-db-id' }),
    deleteExpiredSessions: vi.fn().mockResolvedValue({ selected: 0, deleted: 0 }),
    listSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getSession: vi.fn().mockResolvedValue(null),
    getSessionTimeline: vi.fn().mockResolvedValue([]),
    listVisitorSessions: vi.fn().mockResolvedValue([]),
    findDisplayEntities: vi.fn().mockResolvedValue([[], [], [], [], []]),
  } as unknown as PixelJourneyRepository;
}

describe('PixelJourneyService', () => {
  it('materializes Ad A -> Ad B touch history and links checkout to exact Shopify order truth', async () => {
    const productGid = 'gid://shopify/Product/1000';
    const variantGid = 'gid://shopify/ProductVariant/2000';
    const orderGid = 'gid://shopify/Order/9000';
    const events = [
      event({
        eventId: 'event_00000001',
        metaCampaignExternalId: '100',
        metaAdSetExternalId: '200',
        metaAdExternalId: '300',
        metaClickId: 'click-a',
      }),
      event({
        eventId: 'event_00000002',
        eventName: 'PRODUCT_VIEW',
        eventAt: new Date('2026-09-04T10:01:00.000Z'),
        receivedAt: new Date('2026-09-04T10:01:01.000Z'),
        productExternalId: productGid,
        variantExternalId: variantGid,
        metaCampaignExternalId: '100',
        metaAdSetExternalId: '200',
        metaAdExternalId: '300',
        metaClickId: 'click-a',
      }),
      event({
        eventId: 'event_00000003',
        eventAt: new Date('2026-09-04T14:00:00.000Z'),
        receivedAt: new Date('2026-09-04T14:00:01.000Z'),
        metaCampaignExternalId: '100',
        metaAdSetExternalId: '200',
        metaAdExternalId: '301',
        metaClickId: 'click-b',
      }),
      event({
        eventId: 'event_00000004',
        eventName: 'ADD_TO_CART',
        eventAt: new Date('2026-09-04T14:02:00.000Z'),
        receivedAt: new Date('2026-09-04T14:02:01.000Z'),
        productExternalId: productGid,
        variantExternalId: variantGid,
        quantity: 1,
        metaCampaignExternalId: '100',
        metaAdSetExternalId: '200',
        metaAdExternalId: '301',
        metaClickId: 'click-b',
      }),
      event({
        eventId: 'event_00000005',
        eventName: 'BEGIN_CHECKOUT',
        eventAt: new Date('2026-09-04T14:05:00.000Z'),
        receivedAt: new Date('2026-09-04T14:05:01.000Z'),
        shopifyCheckoutToken: 'checkout-token-1',
        metaCampaignExternalId: '100',
        metaAdSetExternalId: '200',
        metaAdExternalId: '301',
        metaClickId: 'click-b',
      }),
      event({
        eventId: 'event_00000006',
        eventName: 'CHECKOUT_COMPLETED',
        eventAt: new Date('2026-09-04T14:10:00.000Z'),
        receivedAt: new Date('2026-09-04T14:10:01.000Z'),
        shopifyCheckoutToken: 'checkout-token-1',
        shopifyOrderExternalId: orderGid,
        metaCampaignExternalId: '100',
        metaAdSetExternalId: '200',
        metaAdExternalId: '301',
        metaClickId: 'click-b',
      }),
    ];
    const repository = buildRepository(events);
    vi.mocked(repository.resolveMetaHierarchy).mockResolvedValue({
      campaigns: [{ id: 'campaign-db', metaCampaignId: '100' }],
      adSets: [
        {
          id: 'adset-db',
          metaAdSetId: '200',
          campaign: { id: 'campaign-db', metaCampaignId: '100' },
        },
      ],
      ads: [
        {
          id: 'ad-a-db',
          metaAdId: '300',
          campaign: { id: 'campaign-db', metaCampaignId: '100' },
          adSet: { id: 'adset-db', metaAdSetId: '200' },
        },
        {
          id: 'ad-b-db',
          metaAdId: '301',
          campaign: { id: 'campaign-db', metaCampaignId: '100' },
          adSet: { id: 'adset-db', metaAdSetId: '200' },
        },
      ],
    } as never);
    vi.mocked(repository.resolveCommerceEntities).mockResolvedValue({
      products: [{ id: 'product-db', shopifyProductId: productGid }],
      variants: [
        {
          id: 'variant-db',
          shopifyVariantId: variantGid,
          product: { id: 'product-db', shopifyProductId: productGid },
        },
      ],
      collections: [],
    } as never);
    vi.mocked(repository.findOrderByExternalId).mockResolvedValue({
      id: 'order-db',
      shopifyOrderId: orderGid,
    } as never);

    const service = new PixelJourneyService(repository, () => fixedNow);
    await service.materializeSession(storeId, browserSessionId);

    const [, , aggregate, touches, products] = vi.mocked(repository.replaceSessionReadModel).mock.calls[0]!;
    expect(aggregate).toMatchObject({
      anonymousVisitorId: visitorId,
      eventCount: 6,
      productViewCount: 1,
      addToCartCount: 1,
      checkoutStartedAt: new Date('2026-09-04T14:05:00.000Z'),
      checkoutCompletedAt: new Date('2026-09-04T14:10:00.000Z'),
      shopifyCheckoutToken: 'checkout-token-1',
      shopifyOrderExternalId: orderGid,
      orderId: 'order-db',
      orderLinkStatus: 'LINKED',
      dataQualityFlags: [],
      materializedAt: fixedNow,
    });
    expect(touches).toHaveLength(2);
    expect(touches.map((touch) => ({
      ordinal: touch.ordinal,
      ad: touch.metaAdExternalId,
      localAd: touch.metaAdId,
      status: touch.metaResolutionStatus,
    }))).toEqual([
      { ordinal: 1, ad: '300', localAd: 'ad-a-db', status: 'EXACT' },
      { ordinal: 2, ad: '301', localAd: 'ad-b-db', status: 'EXACT' },
    ]);
    expect(products).toHaveLength(1);
    expect(products[0]).toMatchObject({
      shopifyProductExternalId: productGid,
      shopifyVariantExternalId: variantGid,
      productId: 'product-db',
      variantId: 'variant-db',
      resolutionStatus: 'EXACT',
      viewCount: 1,
      addToCartCount: 1,
    });
  });

  it('keeps exact checkout evidence pending when Shopify order ingestion has not arrived yet', async () => {
    const orderGid = 'gid://shopify/Order/9999';
    const repository = buildRepository([
      event({
        eventId: 'event_pending_01',
        eventName: 'CHECKOUT_COMPLETED',
        shopifyCheckoutToken: 'checkout-pending',
        shopifyOrderExternalId: orderGid,
        metaCampaignExternalId: '100',
        metaAdSetExternalId: '200',
        metaAdExternalId: '999',
      }),
    ]);
    const service = new PixelJourneyService(repository, () => fixedNow);

    await service.materializeSession(storeId, browserSessionId);

    const [, , aggregate, touches] = vi.mocked(repository.replaceSessionReadModel).mock.calls[0]!;
    expect(aggregate).toMatchObject({
      shopifyOrderExternalId: orderGid,
      orderId: null,
      orderLinkStatus: 'PENDING',
    });
    expect(touches[0]).toMatchObject({
      metaAdExternalId: '999',
      metaResolutionStatus: 'UNRESOLVED',
    });
  });

  it('links pending sessions later when Shopify commerce truth becomes available', async () => {
    const orderGid = 'gid://shopify/Order/7777';
    const repository = buildRepository([]);
    vi.mocked(repository.findPendingOrderSessions).mockResolvedValue([
      { id: 'session-db', storeId, shopifyOrderExternalId: orderGid },
    ] as never);
    vi.mocked(repository.findOrderByExternalId).mockResolvedValue({
      id: 'order-db',
      shopifyOrderId: orderGid,
    } as never);
    const service = new PixelJourneyService(repository, () => fixedNow);

    await expect(service.linkPendingOrders()).resolves.toEqual({
      selected: 1,
      linked: 1,
      stillPending: 0,
    });
    expect(repository.setOrderLink).toHaveBeenCalledWith('session-db', 'order-db');
  });
});
