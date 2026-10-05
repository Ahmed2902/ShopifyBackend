import { prisma } from '../../lib/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import type { ConversionDestinationConfig, DeliveryClaim } from './conversion-delivery.types.js';

type ObservedItem = { variantExternalId: string; quantity?: number; itemPrice?: number };
type Mapping = {
  variant: { shopifyVariantId: string; storeId: string };
  catalogItem: { retailerId: string | null; catalog: { id: string; storeId: string } };
};
const MAX_ITEMS = 100;

export function resolveContentItems(items: ObservedItem[], mappings: Mapping[]) {
  const identifiers = new Map<string, Set<string>>();
  for (const mapping of mappings) {
    const id = mapping.catalogItem.retailerId;
    if (!id || id.length > 256 || id.includes('@') || [...id].some((c) => c.charCodeAt(0) < 32))
      continue;
    const ids = identifiers.get(mapping.variant.shopifyVariantId) ?? new Set<string>();
    ids.add(id);
    identifiers.set(mapping.variant.shopifyVariantId, ids);
  }
  const contents: NonNullable<DeliveryClaim['contents']> = [];
  let ambiguousItems = 0;
  for (const item of items.slice(0, MAX_ITEMS)) {
    const ids = identifiers.get(item.variantExternalId);
    if (!ids?.size) continue;
    if (ids.size !== 1) {
      ambiguousItems++;
      continue;
    }
    contents.push({
      id: [...ids][0]!,
      ...(item.quantity !== undefined ? { quantity: item.quantity } : {}),
      ...(item.itemPrice !== undefined ? { itemPrice: item.itemPrice } : {}),
    });
  }
  return {
    contents,
    contentFacts: {
      observedItems: Math.min(items.length, MAX_ITEMS),
      mappedItems: contents.length,
      ambiguousItems,
      truncated: items.length > MAX_ITEMS,
    },
  };
}

// Batch all source and catalog reads. No provider call, protected customer query or guessed ID scheme.
export async function prepareConversionContents(claims: DeliveryClaim[]) {
  const relevant = claims.filter((c) => c.provider !== 'GOOGLE_ADS');
  if (!relevant.length) return;
  const storeIds = [...new Set(relevant.map((c) => c.storeId))];
  const orderIds = relevant.flatMap((c) => (c.sourceOrderId ? [c.sourceOrderId] : []));
  const eventIds = relevant.flatMap((c) => (c.sourceEventId ? [c.sourceEventId] : []));
  const [orders, events] = await Promise.all([
    orderIds.length
      ? prisma.order.findMany({
          where: {
            id: { in: orderIds },
            storeId: { in: storeIds },
            isTest: false,
            cancelledAt: null,
          },
          select: {
            id: true,
            storeId: true,
            lineItems: {
              orderBy: { id: 'asc' },
              take: MAX_ITEMS + 1,
              select: {
                shopifyVariantId: true,
                quantity: true,
                discountedUnitPriceAfterAllDiscounts: true,
                originalUnitPrice: true,
              },
            },
          },
        })
      : [],
    eventIds.length
      ? prisma.storefrontEvent.findMany({
          where: { id: { in: eventIds }, storeId: { in: storeIds } },
          select: {
            id: true,
            storeId: true,
            commerceItems: true,
            commerceCurrencyCode: true,
            variantExternalId: true,
            quantity: true,
          },
        })
      : [],
  ]);
  const ordersById = new Map(orders.map((order) => [order.id, order]));
  const eventsById = new Map(events.map((event) => [event.id, event]));
  const readItems = (c: DeliveryClaim): ObservedItem[] => {
    if ((c.eventName ?? 'PURCHASE') === 'PURCHASE') {
      const sourceOrder = c.sourceOrderId ? ordersById.get(c.sourceOrderId) : undefined;
      const order = sourceOrder?.storeId === c.storeId ? sourceOrder : undefined;
      return (order?.lineItems ?? []).flatMap((line) => {
        if (!line.shopifyVariantId || line.quantity < 1) return [];
        const price = line.discountedUnitPriceAfterAllDiscounts ?? line.originalUnitPrice;
        return [
          {
            variantExternalId: line.shopifyVariantId,
            quantity: line.quantity,
            ...(price !== null && Number.isFinite(Number(price)) && Number(price) >= 0
              ? { itemPrice: Number(price) }
              : {}),
          },
        ];
      });
    }
    const sourceEvent = c.sourceEventId ? eventsById.get(c.sourceEventId) : undefined;
    const event = sourceEvent?.storeId === c.storeId ? sourceEvent : undefined;
    if (event?.commerceCurrencyCode) c.currencyCode = event.commerceCurrencyCode;
    const items = Array.isArray(event?.commerceItems)
      ? (event.commerceItems as ObservedItem[])
      : event?.variantExternalId
        ? [
            {
              variantExternalId: event.variantExternalId,
              ...(event.quantity ? { quantity: event.quantity } : {}),
            },
          ]
        : [];
    // Prices are browser-observed funnel evidence, never Purchase truth.
    if (
      c.currencyCode &&
      items.length &&
      items.every((i) => i.quantity !== undefined && i.itemPrice !== undefined)
    )
      c.value = new Prisma.Decimal(items.reduce((sum, i) => sum + i.quantity! * i.itemPrice!, 0));
    return items;
  };
  const itemsByClaim = new Map(relevant.map((c) => [c.id, readItems(c)]));
  const variants = [
    ...new Set(
      [...itemsByClaim.values()].flatMap((items) => items.map((i) => i.variantExternalId)),
    ),
  ];
  const catalogIds = (provider: string) =>
    relevant
      .filter((c) => c.provider === provider)
      .flatMap((c) => {
        const id = (c.destination.configJson as ConversionDestinationConfig | null)?.catalogId;
        return id ? [id] : [];
      });
  const where = (ids: string[]) => ({
    validFrom: { lte: new Date() },
    OR: [{ validUntil: null }, { validUntil: { gt: new Date() } }],
    AND: [
      {
        OR: [{ isMerchantConfirmed: true }, { source: 'RETAILER_ID_SKU' as const, confidence: 1 }],
      },
    ],
    variant: { storeId: { in: storeIds }, shopifyVariantId: { in: variants }, deletedAt: null },
    catalogItem: {
      deletedAt: null,
      catalog: {
        id: { in: ids },
        storeId: { in: storeIds },
        connection: { status: 'ACTIVE' as const },
      },
    },
  });
  const select = {
    variant: { select: { shopifyVariantId: true, storeId: true } },
    catalogItem: { select: { retailerId: true, catalog: { select: { id: true, storeId: true } } } },
  } as const;
  const [meta, tiktok] = await Promise.all([
    variants.length && catalogIds('META').length
      ? prisma.catalogItemVariantMapping.findMany({ where: where(catalogIds('META')), select })
      : [],
    variants.length && catalogIds('TIKTOK').length
      ? prisma.tikTokCatalogItemVariantMapping.findMany({
          where: where(catalogIds('TIKTOK')),
          select,
        })
      : [],
  ]);
  const mappingsByCatalog = new Map<string, Mapping[]>();
  const keyFor = (provider: string, storeId: string, catalogId: string | null | undefined) =>
    JSON.stringify([provider, storeId, catalogId]);
  for (const [provider, mappings] of [
    ['META', meta],
    ['TIKTOK', tiktok],
  ] as const) {
    for (const mapping of mappings) {
      if (mapping.variant.storeId !== mapping.catalogItem.catalog.storeId) continue;
      const key = keyFor(provider, mapping.variant.storeId, mapping.catalogItem.catalog.id);
      const group = mappingsByCatalog.get(key) ?? [];
      group.push(mapping);
      mappingsByCatalog.set(key, group);
    }
  }
  for (const c of relevant) {
    const catalogId = (c.destination.configJson as ConversionDestinationConfig | null)?.catalogId;
    const mappings = mappingsByCatalog.get(keyFor(c.provider, c.storeId, catalogId)) ?? [];
    Object.assign(c, resolveContentItems(itemsByClaim.get(c.id) ?? [], mappings));
  }
}

export function metaCustomData(delivery: DeliveryClaim) {
  const contents = delivery.contents ?? [];
  return {
    ...(delivery.currencyCode ? { currency: delivery.currencyCode } : {}),
    ...(delivery.value !== null && delivery.value !== undefined
      ? { value: Number(delivery.value) }
      : {}),
    ...(delivery.shopifyOrderId ? { order_id: delivery.shopifyOrderId } : {}),
    ...(contents.length
      ? {
          content_type: 'product',
          content_ids: [...new Set(contents.map((i) => i.id))],
          contents: contents.map((i) => ({
            id: i.id,
            ...(i.quantity !== undefined ? { quantity: i.quantity } : {}),
            ...(i.itemPrice !== undefined && delivery.currencyCode
              ? { item_price: i.itemPrice }
              : {}),
          })),
          ...(contents.every((i) => i.quantity !== undefined) &&
          !delivery.contentFacts?.truncated &&
          (!delivery.contentFacts ||
            delivery.contentFacts.mappedItems === delivery.contentFacts.observedItems)
            ? { num_items: contents.reduce((n, i) => n + i.quantity!, 0) }
            : {}),
        }
      : {}),
  };
}
export function tiktokProperties(delivery: DeliveryClaim) {
  const meta = metaCustomData(delivery);
  const { contents: _contents, num_items: _numItems, ...base } = meta;
  return {
    ...base,
    ...(delivery.contents?.length
      ? {
          contents: delivery.contents.map((i) => ({
            content_id: i.id,
            ...(i.quantity !== undefined ? { quantity: i.quantity } : {}),
            ...(i.itemPrice !== undefined && delivery.currencyCode ? { price: i.itemPrice } : {}),
          })),
          ...(meta.num_items !== undefined ? { quantity: meta.num_items } : {}),
        }
      : {}),
  };
}
