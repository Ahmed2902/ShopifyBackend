import { Prisma } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import type { MetaCatalogAsset } from '../meta.types.js';
import type { MetaCatalogItemPayload } from './meta-catalog.schema.js';

function currencyFractionDigits(currency: string): number {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions()
      .maximumFractionDigits;
  } catch {
    return 2;
  }
}

function parsePrice(value: string | number | null | undefined, currencyHint: string | null) {
  if (value === null || value === undefined) return { minor: null, currency: currencyHint };
  const raw = String(value).trim();
  const match = raw.match(/^([+-]?\d+(?:\.\d+)?)\s*([A-Za-z]{3})?$/);
  if (!match) return { minor: null, currency: currencyHint };
  const currency = (match[2] ?? currencyHint)?.toUpperCase() ?? null;
  if (!currency) return { minor: null, currency: null };
  const digits = currencyFractionDigits(currency);
  const [whole, fraction = ''] = match[1]!.split('.');
  const normalizedFraction = fraction.padEnd(digits, '0').slice(0, digits);
  if (fraction.length > digits && /[1-9]/.test(fraction.slice(digits))) {
    return { minor: null, currency };
  }
  const sign = whole!.startsWith('-') ? -1n : 1n;
  const absoluteWhole = whole!.replace(/^[+-]/, '');
  const scale = 10n ** BigInt(digits);
  return {
    minor: sign * (BigInt(absoluteWhole) * scale + BigInt(normalizedFraction || '0')),
    currency,
  };
}

export class MetaCatalogRepository {
  async configureSelection(
    storeId: string,
    connectionId: string,
    catalogs: MetaCatalogAsset[],
  ) {
    return prisma.$transaction(async (tx) => {
      for (const catalog of catalogs) {
        await tx.metaProductCatalog.upsert({
          where: { storeId_metaCatalogId: { storeId, metaCatalogId: catalog.id } },
          create: {
            storeId,
            metaConnectionId: connectionId,
            metaCatalogId: catalog.id,
            name: catalog.name,
            businessId: catalog.businessId,
            ownerBusinessId: catalog.ownerBusinessId,
            vertical: catalog.vertical,
            productCount: catalog.productCount,
            feedCount: catalog.feedCount,
            rawJson: catalog.raw as Prisma.InputJsonValue,
          },
          update: {
            metaConnectionId: connectionId,
            name: catalog.name,
            businessId: catalog.businessId,
            ownerBusinessId: catalog.ownerBusinessId,
            vertical: catalog.vertical,
            productCount: catalog.productCount,
            feedCount: catalog.feedCount,
            rawJson: catalog.raw as Prisma.InputJsonValue,
          },
        });
      }
      return tx.metaConnection.update({
        where: { id: connectionId },
        data: { selectedCatalogIds: catalogs.map((catalog) => catalog.id) },
        select: { selectedCatalogIds: true },
      });
    });
  }

  findCatalog(storeId: string, connectionId: string, metaCatalogId: string) {
    return prisma.metaProductCatalog.findFirst({
      where: { storeId, metaConnectionId: connectionId, metaCatalogId },
      select: { id: true, metaCatalogId: true },
    });
  }

  upsertItem(catalogId: string, item: MetaCatalogItemPayload) {
    const basePrice = parsePrice(item.price, item.currency ?? null);
    const salePrice = parsePrice(item.sale_price, basePrice.currency);
    const currency = basePrice.currency ?? salePrice.currency;
    const customLabels = {
      label0: item.custom_label_0 ?? null,
      label1: item.custom_label_1 ?? null,
      label2: item.custom_label_2 ?? null,
      label3: item.custom_label_3 ?? null,
      label4: item.custom_label_4 ?? null,
    };
    const data = {
      retailerId: item.retailer_id ?? null,
      retailerProductGroupId: item.retailer_product_group_id ?? null,
      parentProductId: item.parent_product_id ?? null,
      name: item.name ?? null,
      brand: item.brand ?? null,
      availability: item.availability ?? null,
      priceMinor: basePrice.minor,
      salePriceMinor: salePrice.minor,
      currency,
      size: item.size ?? null,
      color: item.color ?? null,
      pattern: item.pattern ?? null,
      url: item.url ?? null,
      productType: item.product_type ?? null,
      customLabels: customLabels as Prisma.InputJsonValue,
      productFeedId: item.product_feed?.id ?? null,
      quantityToSellOnFacebook: item.quantity_to_sell_on_facebook ?? null,
      status: item.status ?? null,
      visibility: item.visibility ?? null,
      deletedAt: null,
      rawJson: item as unknown as Prisma.InputJsonValue,
    };
    return prisma.metaCatalogItem.upsert({
      where: { catalogId_metaProductItemId: { catalogId, metaProductItemId: item.id } },
      create: { catalogId, metaProductItemId: item.id, ...data },
      update: data,
      select: { id: true, metaProductItemId: true },
    });
  }

  softDeleteMissingItems(catalogId: string, metaProductItemIds: string[]) {
    return prisma.metaCatalogItem.updateMany({
      where: { catalogId, deletedAt: null, metaProductItemId: { notIn: metaProductItemIds } },
      data: { deletedAt: new Date() },
    });
  }

  markCatalogSynced(catalogId: string, syncedAt = new Date()) {
    return prisma.metaProductCatalog.update({
      where: { id: catalogId },
      data: { lastSyncedAt: syncedAt },
    });
  }

  listCatalogs(storeId: string, selectedIds: string[]) {
    return prisma.metaProductCatalog.findMany({
      where: { storeId, metaCatalogId: { in: selectedIds } },
      select: {
        metaCatalogId: true,
        name: true,
        businessId: true,
        ownerBusinessId: true,
        vertical: true,
        productCount: true,
        feedCount: true,
        lastSyncedAt: true,
        _count: { select: { items: { where: { deletedAt: null } } } },
      },
      orderBy: { name: 'asc' },
    });
  }

  listItems(storeId: string, metaCatalogId: string, page: number, limit: number) {
    const where = {
      catalog: { storeId, metaCatalogId },
      deletedAt: null,
    } satisfies Prisma.MetaCatalogItemWhereInput;
    return prisma.$transaction([
      prisma.metaCatalogItem.findMany({
        where,
        select: {
          metaProductItemId: true,
          retailerId: true,
          retailerProductGroupId: true,
          parentProductId: true,
          name: true,
          brand: true,
          availability: true,
          priceMinor: true,
          salePriceMinor: true,
          currency: true,
          size: true,
          color: true,
          pattern: true,
          url: true,
          productType: true,
          customLabels: true,
          productFeedId: true,
          quantityToSellOnFacebook: true,
          status: true,
          visibility: true,
        },
        orderBy: [{ name: 'asc' }, { metaProductItemId: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.metaCatalogItem.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  async requireSelectedCatalog(storeId: string, metaCatalogId: string) {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedCatalogIds: true },
    });
    if (!connection?.selectedCatalogIds.includes(metaCatalogId)) {
      throw new AppError('Meta catalog is not selected for this store', 404, 'META_CATALOG_NOT_FOUND');
    }
  }
}
