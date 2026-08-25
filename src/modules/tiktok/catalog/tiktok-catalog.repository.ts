import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;
const optionalJson = (value: unknown): Prisma.InputJsonValue | undefined =>
  value === undefined || value === null ? undefined : json(value);

export class TikTokCatalogRepository {
  upsertCatalog(input: {
    storeId: string;
    connectionId: string;
    tiktokCatalogId: string;
    name: string;
    businessCenterId?: string | null;
    catalogType?: string | null;
    vertical?: string | null;
    region?: string | null;
    currency?: string | null;
    productCount?: number | null;
    raw: unknown;
  }) {
    const data = {
      tiktokConnectionId: input.connectionId,
      name: input.name,
      businessCenterId: input.businessCenterId,
      catalogType: input.catalogType,
      vertical: input.vertical,
      region: input.region,
      currency: input.currency,
      productCount: input.productCount,
      lastSyncedAt: new Date(),
      rawJson: json(input.raw),
    };
    return prisma.tikTokCatalog.upsert({
      where: { storeId_tiktokCatalogId: { storeId: input.storeId, tiktokCatalogId: input.tiktokCatalogId } },
      create: { storeId: input.storeId, tiktokCatalogId: input.tiktokCatalogId, ...data },
      update: data,
    });
  }

  listCatalogs(storeId: string) {
    return prisma.tikTokCatalog.findMany({ where: { storeId }, orderBy: { name: 'asc' } });
  }

  upsertCatalogItem(input: {
    catalogId: string;
    tiktokProductId: string;
    retailerId?: string | null;
    itemGroupId?: string | null;
    title?: string | null;
    description?: string | null;
    brand?: string | null;
    availability?: string | null;
    price?: string | number | null;
    salePrice?: string | number | null;
    currency?: string | null;
    size?: string | null;
    color?: string | null;
    pattern?: string | null;
    url?: string | null;
    imageUrl?: string | null;
    productType?: string | null;
    category?: string | null;
    customLabels?: unknown;
    variants?: unknown;
    videoIds?: unknown;
    status?: string | null;
    raw: unknown;
  }) {
    const data = {
      retailerId: input.retailerId,
      itemGroupId: input.itemGroupId,
      title: input.title,
      description: input.description,
      brand: input.brand,
      availability: input.availability,
      price: input.price,
      salePrice: input.salePrice,
      currency: input.currency,
      size: input.size,
      color: input.color,
      pattern: input.pattern,
      url: input.url,
      imageUrl: input.imageUrl,
      productType: input.productType,
      category: input.category,
      customLabels: optionalJson(input.customLabels),
      variants: optionalJson(input.variants),
      videoIds: optionalJson(input.videoIds),
      status: input.status,
      deletedAt: null,
      rawJson: json(input.raw),
    };
    return prisma.tikTokCatalogItem.upsert({
      where: { catalogId_tiktokProductId: { catalogId: input.catalogId, tiktokProductId: input.tiktokProductId } },
      create: { catalogId: input.catalogId, tiktokProductId: input.tiktokProductId, ...data },
      update: data,
    });
  }

  tombstoneMissingCatalogItems(catalogId: string, activeIds: string[]) {
    return prisma.tikTokCatalogItem.updateMany({
      where: {
        catalogId,
        deletedAt: null,
        ...(activeIds.length > 0 ? { tiktokProductId: { notIn: activeIds } } : {}),
      },
      data: { deletedAt: new Date() },
    });
  }

  listCatalogItems(storeId: string, tiktokCatalogId: string, page: number, limit: number) {
    const where: Prisma.TikTokCatalogItemWhereInput = {
      catalog: { storeId, tiktokCatalogId },
      deletedAt: null,
    };
    return Promise.all([
      prisma.tikTokCatalogItem.findMany({
        where,
        include: {
          variantMappings: {
            where: { validUntil: null },
            include: { variant: { include: { product: true, options: true } } },
          },
        },
        orderBy: { title: 'asc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.tikTokCatalogItem.count({ where }),
    ]);
  }
}
