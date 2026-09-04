import { AppError } from '../../../errors/app-error.js';
import {
  PixelJourneyRepository,
  type SessionCollectionInput,
  type SessionProductInput,
  type SessionTouchInput,
} from './pixel-journey.repository.js';

const DEFAULT_REPAIR_BATCH = 100;
const MAX_REPAIR_BATCH = 500;
const DEFAULT_RETENTION_BATCH = 1_000;
const MAX_VISITOR_SESSIONS = 100;

type JourneyEvent = Awaited<
  ReturnType<PixelJourneyRepository['findSessionEvents']>
>[number];
type JourneySession = NonNullable<
  Awaited<ReturnType<PixelJourneyRepository['getSession']>>
>;
type ResolutionStatus = 'NONE' | 'EXACT' | 'PARTIAL' | 'UNRESOLVED' | 'CONFLICT';
type JourneySource = 'META' | 'GOOGLE' | 'TIKTOK' | 'UTM' | 'REFERRER' | 'DIRECT' | 'UNKNOWN';

function nonEmpty(values: Array<string | null>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function unique(values: Array<string | null>): string[] {
  return [...new Set(nonEmpty(values))];
}

function maxDate(values: Date[]): Date {
  return values.reduce((latest, value) => (value > latest ? value : latest));
}

function minDate(values: Date[]): Date {
  return values.reduce((earliest, value) => (value < earliest ? value : earliest));
}

function sourceFor(event: JourneyEvent): JourneySource {
  if (event.metaAdExternalId || event.metaAdSetExternalId || event.metaCampaignExternalId || event.metaClickId) {
    return 'META';
  }
  if (event.googleClickId) return 'GOOGLE';
  if (event.tiktokClickId) return 'TIKTOK';
  if (event.utmSource || event.utmMedium || event.utmCampaign || event.utmContent || event.utmTerm) {
    return 'UTM';
  }
  if (event.referrerUrl) return 'REFERRER';
  if (event.landingPageUrl || event.pageUrl) return 'DIRECT';
  return 'UNKNOWN';
}

function touchSignature(event: JourneyEvent): string {
  return JSON.stringify([
    event.landingPageUrl,
    event.utmSource,
    event.utmMedium,
    event.utmCampaign,
    event.utmContent,
    event.utmTerm,
    event.metaClickId,
    event.googleClickId,
    event.tiktokClickId,
    event.metaCampaignExternalId,
    event.metaAdSetExternalId,
    event.metaAdExternalId,
  ]);
}

function buildRawTouches(events: JourneyEvent[]): SessionTouchInput[] {
  const touches: SessionTouchInput[] = [];
  let previousSignature: string | null = null;

  for (const event of events) {
    const signature = touchSignature(event);
    if (touches.length > 0 && signature === previousSignature) continue;
    previousSignature = signature;

    touches.push({
      ordinal: touches.length + 1,
      eventAt: event.eventAt,
      source: sourceFor(event),
      landingPageUrl: event.landingPageUrl,
      referrerUrl: event.referrerUrl,
      utmSource: event.utmSource,
      utmMedium: event.utmMedium,
      utmCampaign: event.utmCampaign,
      utmContent: event.utmContent,
      utmTerm: event.utmTerm,
      metaClickId: event.metaClickId,
      googleClickId: event.googleClickId,
      tiktokClickId: event.tiktokClickId,
      metaCampaignExternalId: event.metaCampaignExternalId,
      metaAdSetExternalId: event.metaAdSetExternalId,
      metaAdExternalId: event.metaAdExternalId,
      metaCampaignId: null,
      metaAdSetId: null,
      metaAdId: null,
      metaResolutionStatus: 'NONE',
    });
  }

  return touches;
}

function productIdentity(event: JourneyEvent): string | null {
  if (event.variantExternalId) return `variant:${event.variantExternalId}`;
  if (event.productExternalId) return `product:${event.productExternalId}`;
  return null;
}

function buildRawProducts(events: JourneyEvent[]): SessionProductInput[] {
  const aggregates = new Map<string, SessionProductInput>();
  for (const event of events) {
    if (
      event.eventName !== 'PRODUCT_VIEW' &&
      event.eventName !== 'ADD_TO_CART' &&
      event.eventName !== 'REMOVE_FROM_CART'
    ) {
      continue;
    }
    const identityKey = productIdentity(event);
    if (!identityKey) continue;

    const existing = aggregates.get(identityKey);
    const row: SessionProductInput = existing ?? {
      identityKey,
      shopifyProductExternalId: event.productExternalId,
      shopifyVariantExternalId: event.variantExternalId,
      productId: null,
      variantId: null,
      resolutionStatus: 'NONE',
      viewCount: 0,
      addToCartCount: 0,
      removeFromCartCount: 0,
      firstSeenAt: event.eventAt,
      lastSeenAt: event.eventAt,
    };

    if (!row.shopifyProductExternalId && event.productExternalId) {
      row.shopifyProductExternalId = event.productExternalId;
    }
    if (event.eventName === 'PRODUCT_VIEW') row.viewCount += 1;
    if (event.eventName === 'ADD_TO_CART') row.addToCartCount += 1;
    if (event.eventName === 'REMOVE_FROM_CART') row.removeFromCartCount += 1;
    if (event.eventAt < row.firstSeenAt) row.firstSeenAt = event.eventAt;
    if (event.eventAt > row.lastSeenAt) row.lastSeenAt = event.eventAt;
    aggregates.set(identityKey, row);
  }
  return [...aggregates.values()].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
}

function buildRawCollections(events: JourneyEvent[]): SessionCollectionInput[] {
  const aggregates = new Map<string, SessionCollectionInput>();
  for (const event of events) {
    if (event.eventName !== 'COLLECTION_VIEW' || !event.collectionExternalId) continue;
    const existing = aggregates.get(event.collectionExternalId);
    const row: SessionCollectionInput = existing ?? {
      shopifyCollectionExternalId: event.collectionExternalId,
      collectionId: null,
      resolutionStatus: 'NONE',
      viewCount: 0,
      firstSeenAt: event.eventAt,
      lastSeenAt: event.eventAt,
    };
    row.viewCount += 1;
    if (event.eventAt < row.firstSeenAt) row.firstSeenAt = event.eventAt;
    if (event.eventAt > row.lastSeenAt) row.lastSeenAt = event.eventAt;
    aggregates.set(event.collectionExternalId, row);
  }
  return [...aggregates.values()].sort((a, b) => a.firstSeenAt.getTime() - b.firstSeenAt.getTime());
}

export class PixelJourneyService {
  constructor(
    private readonly repository: PixelJourneyRepository = new PixelJourneyRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async materializeSessions(storeId: string, browserSessionIds: string[]) {
    const ids = [...new Set(browserSessionIds.filter(Boolean))];
    let materialized = 0;
    let failed = 0;
    for (const browserSessionId of ids) {
      try {
        const result = await this.materializeSession(storeId, browserSessionId);
        if (result) materialized += 1;
      } catch {
        failed += 1;
      }
    }
    return { requested: ids.length, materialized, failed };
  }

  async materializeSession(storeId: string, browserSessionId: string) {
    const events = await this.repository.findSessionEvents(storeId, browserSessionId);
    if (events.length === 0) return null;

    const touches = buildRawTouches(events);
    const products = buildRawProducts(events);
    const collections = buildRawCollections(events);

    await Promise.all([
      this.resolveMetaTouches(storeId, touches),
      this.resolveProductsAndCollections(storeId, products, collections),
    ]);

    const visitorIds = unique(events.map((event) => event.anonymousVisitorId));
    const orderIds = unique(events.map((event) => event.shopifyOrderExternalId));
    const checkoutTokens = unique(events.map((event) => event.shopifyCheckoutToken));
    const dataQualityFlags: string[] = [];
    if (visitorIds.length > 1) dataQualityFlags.push('MULTIPLE_VISITOR_IDS');
    if (orderIds.length > 1) dataQualityFlags.push('MULTIPLE_ORDER_IDS');
    if (checkoutTokens.length > 1) dataQualityFlags.push('MULTIPLE_CHECKOUT_TOKENS');
    if (touches.some((touch) => touch.metaResolutionStatus === 'CONFLICT')) {
      dataQualityFlags.push('META_HIERARCHY_CONFLICT');
    }
    if (products.some((product) => product.resolutionStatus === 'CONFLICT')) {
      dataQualityFlags.push('SHOPIFY_PRODUCT_ID_CONFLICT');
    }

    const shopifyOrderExternalId = orderIds.at(-1) ?? null;
    const linkedOrder = shopifyOrderExternalId
      ? await this.repository.findOrderByExternalId(storeId, shopifyOrderExternalId)
      : null;
    const checkoutStartedEvents = events.filter((event) => event.eventName === 'BEGIN_CHECKOUT');
    const checkoutCompletedEvents = events.filter((event) => event.eventName === 'CHECKOUT_COMPLETED');

    const aggregate = {
      anonymousVisitorId: visitorIds[0] ?? null,
      startedAt: minDate(events.map((event) => event.eventAt)),
      endedAt: maxDate(events.map((event) => event.eventAt)),
      lastSourceReceivedAt: maxDate(events.map((event) => event.receivedAt)),
      eventCount: events.length,
      pageViewCount: events.filter((event) => event.eventName === 'PAGE_VIEW').length,
      productViewCount: events.filter((event) => event.eventName === 'PRODUCT_VIEW').length,
      collectionViewCount: events.filter((event) => event.eventName === 'COLLECTION_VIEW').length,
      searchCount: events.filter((event) => event.eventName === 'SEARCH').length,
      addToCartCount: events.filter((event) => event.eventName === 'ADD_TO_CART').length,
      removeFromCartCount: events.filter((event) => event.eventName === 'REMOVE_FROM_CART').length,
      checkoutProgressCount: events.filter((event) => event.eventName === 'CHECKOUT_PROGRESS').length,
      checkoutStartedAt:
        checkoutStartedEvents.length > 0
          ? minDate(checkoutStartedEvents.map((event) => event.eventAt))
          : null,
      checkoutCompletedAt:
        checkoutCompletedEvents.length > 0
          ? minDate(checkoutCompletedEvents.map((event) => event.eventAt))
          : null,
      shopifyCheckoutToken: checkoutTokens.at(-1) ?? null,
      shopifyOrderExternalId,
      orderId: linkedOrder?.id ?? null,
      orderLinkStatus: shopifyOrderExternalId
        ? linkedOrder
          ? ('LINKED' as const)
          : ('PENDING' as const)
        : ('NONE' as const),
      landingPageUrl: events[0]?.landingPageUrl ?? events[0]?.pageUrl ?? null,
      initialReferrerUrl: events[0]?.referrerUrl ?? null,
      dataQualityFlags,
      retentionExpiresAt: maxDate(events.map((event) => event.retentionExpiresAt)),
      materializedAt: this.now(),
    };

    return this.repository.replaceSessionReadModel(
      storeId,
      browserSessionId,
      aggregate,
      touches,
      products,
      collections,
    );
  }

  async repairDirtySessions(limit = DEFAULT_REPAIR_BATCH) {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_REPAIR_BATCH);
    const dirty = await this.repository.findDirtySessionKeys(bounded);
    let materialized = 0;
    let failed = 0;
    for (const row of dirty) {
      try {
        const result = await this.materializeSession(row.storeId, row.browserSessionId);
        if (result) materialized += 1;
      } catch {
        failed += 1;
      }
    }
    return { selected: dirty.length, materialized, failed };
  }

  async linkPendingOrders(limit = DEFAULT_REPAIR_BATCH) {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_REPAIR_BATCH);
    const sessions = await this.repository.findPendingOrderSessions(bounded);
    let linked = 0;
    for (const session of sessions) {
      if (!session.shopifyOrderExternalId) continue;
      const order = await this.repository.findOrderByExternalId(
        session.storeId,
        session.shopifyOrderExternalId,
      );
      if (!order) continue;
      await this.repository.setOrderLink(session.id, order.id);
      linked += 1;
    }
    return { selected: sessions.length, linked, stillPending: sessions.length - linked };
  }

  cleanupExpiredSessions(limit = DEFAULT_RETENTION_BATCH) {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), 10_000);
    return this.repository.deleteExpiredSessions(this.now(), bounded);
  }

  async listSessions(
    storeId: string,
    input: {
      from?: Date;
      to?: Date;
      source?: JourneySource;
      metaAdExternalId?: string;
      productExternalId?: string;
      checkoutCompleted?: boolean;
      page: number;
      limit: number;
    },
  ) {
    const result = await this.repository.listSessions(storeId, input);
    return {
      items: await this.decorateSessions(result.items),
      pagination: { page: input.page, limit: input.limit, total: result.total },
    };
  }

  async getSession(storeId: string, sessionId: string) {
    const session = await this.repository.getSession(storeId, sessionId);
    if (!session) throw new AppError('Storefront session not found', 404, 'PIXEL_SESSION_NOT_FOUND');
    const [decorated] = await this.decorateSessions([session]);
    const timeline = await this.repository.getSessionTimeline(storeId, session.browserSessionId);
    return { ...decorated, timeline };
  }

  async getVisitorJourney(storeId: string, anonymousVisitorId: string, limit = MAX_VISITOR_SESSIONS) {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_VISITOR_SESSIONS);
    const sessions = await this.repository.listVisitorSessions(storeId, anonymousVisitorId, bounded);
    if (sessions.length === 0) {
      throw new AppError('Storefront visitor journey not found', 404, 'PIXEL_JOURNEY_NOT_FOUND');
    }
    return {
      anonymousVisitorId,
      sessionCount: sessions.length,
      firstSeenAt: sessions[0]!.startedAt,
      lastSeenAt: sessions.at(-1)!.endedAt,
      sessions: await this.decorateSessions(sessions),
      interpretation: 'Observed first-party journey evidence; no causal attribution is implied.',
    };
  }

  private async resolveMetaTouches(storeId: string, touches: SessionTouchInput[]) {
    const campaignIds = unique(touches.map((touch) => touch.metaCampaignExternalId ?? null));
    const adSetIds = unique(touches.map((touch) => touch.metaAdSetExternalId ?? null));
    const adIds = unique(touches.map((touch) => touch.metaAdExternalId ?? null));
    const resolved = await this.repository.resolveMetaHierarchy(storeId, {
      campaignIds,
      adSetIds,
      adIds,
    });
    const campaignMap = new Map(resolved.campaigns.map((row) => [row.metaCampaignId, row]));
    const adSetMap = new Map(resolved.adSets.map((row) => [row.metaAdSetId, row]));
    const adMap = new Map(resolved.ads.map((row) => [row.metaAdId, row]));

    for (const touch of touches) {
      const hasMetaIdentity = Boolean(
        touch.metaCampaignExternalId || touch.metaAdSetExternalId || touch.metaAdExternalId,
      );
      if (!hasMetaIdentity) {
        touch.metaResolutionStatus = 'NONE';
        continue;
      }

      const campaign = touch.metaCampaignExternalId
        ? campaignMap.get(touch.metaCampaignExternalId)
        : undefined;
      const adSet = touch.metaAdSetExternalId ? adSetMap.get(touch.metaAdSetExternalId) : undefined;
      const ad = touch.metaAdExternalId ? adMap.get(touch.metaAdExternalId) : undefined;

      if (ad) {
        const campaignConflict = Boolean(
          touch.metaCampaignExternalId &&
            touch.metaCampaignExternalId !== ad.campaign.metaCampaignId,
        );
        const adSetConflict = Boolean(
          touch.metaAdSetExternalId && touch.metaAdSetExternalId !== ad.adSet.metaAdSetId,
        );
        touch.metaAdId = ad.id;
        touch.metaAdSetId = ad.adSet.id;
        touch.metaCampaignId = ad.campaign.id;
        touch.metaResolutionStatus = campaignConflict || adSetConflict ? 'CONFLICT' : 'EXACT';
        continue;
      }

      if (adSet) {
        const campaignConflict = Boolean(
          touch.metaCampaignExternalId &&
            touch.metaCampaignExternalId !== adSet.campaign.metaCampaignId,
        );
        touch.metaAdSetId = adSet.id;
        touch.metaCampaignId = adSet.campaign.id;
        touch.metaResolutionStatus = campaignConflict ? 'CONFLICT' : 'PARTIAL';
        continue;
      }

      if (campaign) {
        touch.metaCampaignId = campaign.id;
        touch.metaResolutionStatus = 'PARTIAL';
        continue;
      }

      touch.metaResolutionStatus = 'UNRESOLVED';
    }
  }

  private async resolveProductsAndCollections(
    storeId: string,
    products: SessionProductInput[],
    collections: SessionCollectionInput[],
  ) {
    const resolved = await this.repository.resolveCommerceEntities(storeId, {
      productIds: unique(products.map((row) => row.shopifyProductExternalId ?? null)),
      variantIds: unique(products.map((row) => row.shopifyVariantExternalId ?? null)),
      collectionIds: unique(collections.map((row) => row.shopifyCollectionExternalId)),
    });
    const productMap = new Map(resolved.products.map((row) => [row.shopifyProductId, row]));
    const variantMap = new Map(resolved.variants.map((row) => [row.shopifyVariantId, row]));
    const collectionMap = new Map(
      resolved.collections.map((row) => [row.shopifyCollectionId, row]),
    );

    for (const row of products) {
      const variant = row.shopifyVariantExternalId
        ? variantMap.get(row.shopifyVariantExternalId)
        : undefined;
      const product = row.shopifyProductExternalId
        ? productMap.get(row.shopifyProductExternalId)
        : undefined;

      if (variant) {
        row.variantId = variant.id;
        row.productId = variant.product.id;
        row.resolutionStatus =
          row.shopifyProductExternalId &&
          row.shopifyProductExternalId !== variant.product.shopifyProductId
            ? 'CONFLICT'
            : 'EXACT';
      } else if (product) {
        row.productId = product.id;
        row.resolutionStatus = row.shopifyVariantExternalId ? 'PARTIAL' : 'EXACT';
      } else {
        row.resolutionStatus = 'UNRESOLVED';
      }
    }

    for (const row of collections) {
      const collection = collectionMap.get(row.shopifyCollectionExternalId);
      if (collection) {
        row.collectionId = collection.id;
        row.resolutionStatus = 'EXACT';
      } else {
        row.resolutionStatus = 'UNRESOLVED';
      }
    }
  }

  private async decorateSessions<T extends JourneySession>(sessions: T[]) {
    const orderIds = unique(sessions.map((session) => session.orderId));
    const metaAdIds = unique(
      sessions.flatMap((session) => session.touches.map((touch) => touch.metaAdId)),
    );
    const productIds = unique(
      sessions.flatMap((session) => session.products.map((product) => product.productId)),
    );
    const variantIds = unique(
      sessions.flatMap((session) => session.products.map((product) => product.variantId)),
    );
    const collectionIds = unique(
      sessions.flatMap((session) => session.collections.map((collection) => collection.collectionId)),
    );
    const [orders, ads, products, variants, collections] = await this.repository.findDisplayEntities({
      orderIds,
      metaAdIds,
      productIds,
      variantIds,
      collectionIds,
    });
    const orderMap = new Map(orders.map((row) => [row.id, row]));
    const adMap = new Map(ads.map((row) => [row.id, row]));
    const productMap = new Map(products.map((row) => [row.id, row]));
    const variantMap = new Map(variants.map((row) => [row.id, row]));
    const collectionMap = new Map(collections.map((row) => [row.id, row]));

    return sessions.map((session) => ({
      ...session,
      order: session.orderId ? orderMap.get(session.orderId) ?? null : null,
      touches: session.touches.map((touch) => ({
        ...touch,
        metaAd: touch.metaAdId ? adMap.get(touch.metaAdId) ?? null : null,
      })),
      products: session.products.map((product) => ({
        ...product,
        product: product.productId ? productMap.get(product.productId) ?? null : null,
        variant: product.variantId ? variantMap.get(product.variantId) ?? null : null,
      })),
      collections: session.collections.map((collection) => ({
        ...collection,
        collection: collection.collectionId
          ? collectionMap.get(collection.collectionId) ?? null
          : null,
      })),
    }));
  }
}

export const pixelJourneyService = new PixelJourneyService();
