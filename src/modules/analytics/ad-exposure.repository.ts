import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export const AD_EXPOSURE_LIST_MEMBER_LIMIT = 10;
export const AD_EXPOSURE_DETAIL_MEMBER_LIMIT = 100;

function buildAdSelect(collectionMemberLimit: number) {
  return {
    id: true,
    providerEntityId: true,
    name: true,
    status: true,
    effectiveStatus: true,
    targetScope: true,
    targetScopeConfidence: true,
    targetScopeEvidence: true,
    account: { select: { providerEntityId: true, currency: true } },
    campaign: { select: { id: true, providerEntityId: true, name: true } },
    group: { select: { id: true, providerEntityId: true, name: true } },
    creative: {
      select: {
        id: true,
        providerEntityId: true,
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
          { granularity: { not: 'VARIANT' as const } },
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
              orderBy: [{ position: 'asc' as const }, { productId: 'asc' as const }],
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
  } satisfies Prisma.AdvertisingAdSelect;
}

const adListSelect = buildAdSelect(AD_EXPOSURE_LIST_MEMBER_LIMIT);
const adDetailSelect = buildAdSelect(AD_EXPOSURE_DETAIL_MEMBER_LIMIT);
type CanonicalAdExposureRow = Prisma.AdvertisingAdGetPayload<{ select: typeof adListSelect }>;

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

function productOptionMappingIsCurrent(
  mapping: CanonicalAdExposureRow['productMappings'][number],
): boolean {
  if (mapping.granularity !== 'PRODUCT_OPTION') return true;
  const entries = optionSelectorEntries(mapping.optionSelector);
  if (!entries) return false;
  return mapping.product.variants.some((variant) =>
    entries.every(([name, values]) =>
      variant.options.some((option) => option.name === name && values.includes(option.value)),
    ),
  );
}

function compatibilityRow(row: CanonicalAdExposureRow) {
  if (!row.group) return null;
  return {
    id: row.id,
    metaAdId: row.providerEntityId,
    name: row.name,
    configuredStatus: row.status,
    effectiveStatus: row.effectiveStatus,
    targetScope: row.targetScope,
    targetScopeConfidence: row.targetScopeConfidence,
    targetScopeEvidence: row.targetScopeEvidence,
    adAccount: {
      metaAccountId: row.account.providerEntityId,
      currency: row.account.currency,
    },
    campaign: {
      id: row.campaign.id,
      metaCampaignId: row.campaign.providerEntityId,
      name: row.campaign.name,
    },
    adSet: {
      id: row.group.id,
      metaAdSetId: row.group.providerEntityId,
      name: row.group.name,
    },
    creative: row.creative
      ? {
          id: row.creative.id,
          metaCreativeId: row.creative.providerEntityId,
          name: row.creative.name,
          title: row.creative.title,
          thumbnailUrl: row.creative.thumbnailUrl,
        }
      : null,
    productMappings: row.productMappings.filter(productOptionMappingIsCurrent),
    collectionMappings: row.collectionMappings,
  };
}

export class AdExposureRepository {
  async getAdsPage(storeId: string, selectedAccountIds: string[], page: number, limit: number) {
    if (selectedAccountIds.length === 0) return { total: 0, items: [] };
    const where = {
      deletedAt: null,
      groupId: { not: null as string | null },
      account: {
        storeId,
        provider: 'META' as const,
        providerEntityId: { in: selectedAccountIds },
      },
    };
    const [total, rows] = await Promise.all([
      prisma.advertisingAd.count({ where }),
      prisma.advertisingAd.findMany({
        where,
        select: adListSelect,
        orderBy: [{ providerUpdatedAt: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return {
      total,
      items: rows.flatMap((row) => {
        const item = compatibilityRow(row);
        return item ? [item] : [];
      }),
    };
  }

  async getAd(storeId: string, selectedAccountIds: string[], adId: string) {
    if (selectedAccountIds.length === 0) return null;
    const row = await prisma.advertisingAd.findFirst({
      where: {
        id: adId,
        deletedAt: null,
        groupId: { not: null },
        account: {
          storeId,
          provider: 'META',
          providerEntityId: { in: selectedAccountIds },
        },
      },
      select: adDetailSelect,
    });
    return row ? compatibilityRow(row) : null;
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
