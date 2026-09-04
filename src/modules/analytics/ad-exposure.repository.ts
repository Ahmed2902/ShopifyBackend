import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export const AD_EXPOSURE_LIST_MEMBER_LIMIT = 10;
export const AD_EXPOSURE_DETAIL_MEMBER_LIMIT = 100;

function buildAdSelect(collectionMemberLimit: number) {
  return {
    id: true,
    metaAdId: true,
    name: true,
    configuredStatus: true,
    effectiveStatus: true,
    targetScope: true,
    targetScopeConfidence: true,
    targetScopeEvidence: true,
    adAccount: { select: { metaAccountId: true, currency: true } },
    campaign: { select: { id: true, metaCampaignId: true, name: true } },
    adSet: { select: { id: true, metaAdSetId: true, name: true } },
    creative: {
      select: {
        id: true,
        metaCreativeId: true,
        name: true,
        title: true,
        thumbnailUrl: true,
      },
    },
    productMappings: {
      where: {
        validUntil: null,
        product: { deletedAt: null },
        OR: [
          { granularity: { not: 'VARIANT' } },
          { variant: { is: { deletedAt: null } } },
        ],
      },
      select: {
        id: true,
        productId: true,
        variantId: true,
        granularity: true,
        optionSelector: true,
        source: true,
        confidence: true,
        evidenceJson: true,
        landingUrl: true,
        isMerchantConfirmed: true,
        product: {
          select: {
            id: true,
            shopifyProductId: true,
            title: true,
            status: true,
            deletedAt: true,
            variants: {
              where: { deletedAt: null },
              select: {
                id: true,
                shopifyVariantId: true,
                title: true,
                sku: true,
                deletedAt: true,
                options: {
                  select: { name: true, value: true },
                },
              },
            },
          },
        },
        variant: {
          select: {
            id: true,
            shopifyVariantId: true,
            title: true,
            sku: true,
            deletedAt: true,
          },
        },
      },
    },
    collectionMappings: {
      where: { validUntil: null, collection: { deletedAt: null } },
      select: {
        id: true,
        collectionId: true,
        source: true,
        confidence: true,
        evidenceJson: true,
        landingUrl: true,
        isMerchantConfirmed: true,
        collection: {
          select: {
            id: true,
            shopifyCollectionId: true,
            title: true,
            handle: true,
            deletedAt: true,
            _count: {
              select: {
                products: { where: { product: { deletedAt: null } } },
              },
            },
            products: {
              where: { product: { deletedAt: null } },
              take: collectionMemberLimit,
              orderBy: [{ position: 'asc' }, { productId: 'asc' }],
              select: {
                position: true,
                product: {
                  select: {
                    id: true,
                    shopifyProductId: true,
                    title: true,
                    status: true,
                    deletedAt: true,
                  },
                },
              },
            },
          },
        },
      },
    },
  } satisfies Prisma.MetaAdSelect;
}

const adListSelect = buildAdSelect(AD_EXPOSURE_LIST_MEMBER_LIMIT);
const adDetailSelect = buildAdSelect(AD_EXPOSURE_DETAIL_MEMBER_LIMIT);
type AdExposureRow = Prisma.MetaAdGetPayload<{ select: typeof adListSelect }>;

function optionSelectorEntries(value: unknown): Array<[string, string[]]> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries: Array<[string, string[]]> = [];
  for (const [name, rawValues] of Object.entries(value)) {
    if (!Array.isArray(rawValues) || rawValues.length === 0) return null;
    const values = rawValues.filter((item): item is string => typeof item === 'string');
    if (values.length !== rawValues.length || values.length === 0) return null;
    entries.push([name, values]);
  }
  return entries.length > 0 ? entries : null;
}

function productOptionMappingIsCurrent(mapping: AdExposureRow['productMappings'][number]): boolean {
  if (mapping.granularity !== 'PRODUCT_OPTION') return true;
  const entries = optionSelectorEntries(mapping.optionSelector);
  if (!entries) return false;
  return mapping.product.variants.some((variant) =>
    entries.every(([name, values]) =>
      variant.options.some((option) => option.name === name && values.includes(option.value)),
    ),
  );
}

function normalizeCurrentTargets(row: AdExposureRow): AdExposureRow {
  return {
    ...row,
    productMappings: row.productMappings.filter(productOptionMappingIsCurrent),
  };
}

export class AdExposureRepository {
  async getAdsPage(storeId: string, selectedAccountIds: string[], page: number, limit: number) {
    if (selectedAccountIds.length === 0) return { total: 0, items: [] };
    const where = {
      deletedAt: null,
      adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
    };
    const [total, items] = await Promise.all([
      prisma.metaAd.count({ where }),
      prisma.metaAd.findMany({
        where,
        select: adListSelect,
        orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { total, items: items.map(normalizeCurrentTargets) };
  }

  async getAd(storeId: string, selectedAccountIds: string[], adId: string) {
    if (selectedAccountIds.length === 0) return null;
    const row = await prisma.metaAd.findFirst({
      where: {
        id: adId,
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: adDetailSelect,
    });
    return row ? normalizeCurrentTargets(row) : null;
  }

  getInventoryForProducts(storeId: string, productIds: string[]) {
    if (productIds.length === 0) return Promise.resolve([]);
    return prisma.inventoryLevelCurrent.findMany({
      where: {
        inventoryItem: {
          storeId,
          deletedAt: null,
          variant: {
            deletedAt: null,
            productId: { in: productIds },
          },
        },
        location: { deletedAt: null, isActive: true },
      },
      select: {
        available: true,
        incoming: true,
        committed: true,
        onHand: true,
        inventoryItem: {
          select: {
            variant: {
              select: {
                id: true,
                productId: true,
              },
            },
          },
        },
      },
    });
  }
}
