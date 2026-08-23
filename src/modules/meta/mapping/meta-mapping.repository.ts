import { Prisma } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { deriveScopeFromMappings } from './meta-mapping.resolver.js';
import type {
  AdResolution,
  CatalogResolution,
  MappingDataset,
  MappingGranularity,
} from './meta-mapping.types.js';

function jsonOrNull(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null || value === undefined
    ? Prisma.DbNull
    : (value as Prisma.InputJsonValue);
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function catalogSignature(
  mappings: Array<{ variantId: string; source: string; confidence: number }>,
): string {
  return mappings
    .map((mapping) => `${mapping.variantId}|${mapping.source}|${mapping.confidence.toFixed(4)}`)
    .sort()
    .join(';');
}

function adSignature(
  mappings: Array<{
    productId: string;
    variantId: string | null;
    catalogItemId: string | null;
    granularity: string;
    optionSelector: unknown;
    source: string;
    confidence: number;
    landingUrl?: string | null;
    providerProductId?: string | null;
    providerProductGroupId?: string | null;
  }>,
): string {
  return mappings
    .map((mapping) =>
      [
        mapping.productId,
        mapping.variantId ?? '',
        mapping.catalogItemId ?? '',
        mapping.granularity,
        stableJson(mapping.optionSelector),
        mapping.source,
        mapping.confidence.toFixed(4),
        mapping.landingUrl ?? '',
        mapping.providerProductId ?? '',
        mapping.providerProductGroupId ?? '',
      ].join('|'),
    )
    .sort()
    .join(';');
}

export interface ManualAdMappingInput {
  productId: string;
  variantId?: string | null;
  granularity: MappingGranularity;
  optionSelector?: Record<string, string[]> | null;
}

export class MetaMappingRepository {
  async loadDataset(storeId: string): Promise<MappingDataset | null> {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: {
        id: true,
        selectedAdAccountIds: true,
        selectedCatalogIds: true,
        store: {
          select: {
            myshopifyDomain: true,
            primaryDomainHost: true,
            products: {
              where: { deletedAt: null },
              select: {
                id: true,
                shopifyProductId: true,
                handle: true,
                title: true,
                variants: {
                  where: { deletedAt: null },
                  select: {
                    id: true,
                    shopifyVariantId: true,
                    sku: true,
                    options: { select: { name: true, value: true } },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!connection) return null;

    const [catalogItems, ads] = await Promise.all([
      prisma.metaCatalogItem.findMany({
        where: {
          deletedAt: null,
          catalog: { storeId, metaCatalogId: { in: connection.selectedCatalogIds } },
        },
        select: {
          id: true,
          metaProductItemId: true,
          retailerId: true,
          retailerProductGroupId: true,
          parentProductId: true,
          url: true,
          color: true,
          size: true,
          pattern: true,
          name: true,
          variantMappings: {
            where: { validUntil: null },
            select: {
              id: true,
              variantId: true,
              source: true,
              confidence: true,
              isMerchantConfirmed: true,
            },
          },
        },
      }),
      prisma.metaAd.findMany({
        where: {
          deletedAt: null,
          adAccount: { storeId, metaAccountId: { in: connection.selectedAdAccountIds } },
        },
        select: {
          id: true,
          metaAdId: true,
          name: true,
          creative: {
            select: {
              id: true,
              productSetId: true,
              productData: true,
              assetFeedSpec: true,
              resolvedDestinationUrls: true,
              linkUrl: true,
              linkDeepLinkUrl: true,
              objectUrl: true,
              templateUrl: true,
              urlTags: true,
              title: true,
              body: true,
            },
          },
          adSet: { select: { promotedObject: true } },
          campaign: { select: { promotedObject: true } },
          productMappings: {
            where: { validUntil: null },
            select: {
              id: true,
              productId: true,
              variantId: true,
              catalogItemId: true,
              granularity: true,
              optionSelector: true,
              source: true,
              confidence: true,
              isMerchantConfirmed: true,
            },
          },
        },
      }),
    ]);

    return {
      connectionId: connection.id,
      store: {
        myshopifyDomain: connection.store.myshopifyDomain,
        primaryDomainHost: connection.store.primaryDomainHost,
      },
      variants: connection.store.products.flatMap((product) =>
        product.variants.map((variant) => ({
          id: variant.id,
          shopifyVariantId: variant.shopifyVariantId,
          sku: variant.sku,
          productId: product.id,
          shopifyProductId: product.shopifyProductId,
          productHandle: product.handle,
          productTitle: product.title,
          options: variant.options,
        })),
      ),
      catalogItems: catalogItems.map((item) => ({
        ...item,
        activeMappings: item.variantMappings.map((mapping) => ({
          ...mapping,
          confidence: Number(mapping.confidence),
        })),
      })),
      ads: ads.map((ad) => ({
        id: ad.id,
        metaAdId: ad.metaAdId,
        name: ad.name,
        creative: ad.creative,
        adSetPromotedObject: ad.adSet.promotedObject,
        campaignPromotedObject: ad.campaign.promotedObject,
        activeMappings: ad.productMappings.map((mapping) => ({
          ...mapping,
          confidence: Number(mapping.confidence),
        })),
      })),
    };
  }

  async applyAutomaticCatalogResolution(catalogItemId: string, resolution: CatalogResolution) {
    return prisma.$transaction(async (tx) => {
      const active = await tx.catalogItemVariantMapping.findMany({
        where: { catalogItemId, validUntil: null },
        select: {
          id: true,
          variantId: true,
          source: true,
          confidence: true,
          isMerchantConfirmed: true,
        },
      });
      if (active.some((mapping) => mapping.isMerchantConfirmed)) {
        return { state: 'PRESERVED_CONFIRMED' as const, changed: false };
      }

      const desired =
        resolution.state === 'MAPPED' && resolution.source
          ? resolution.variantIds.map((variantId) => ({
              variantId,
              source: resolution.source!,
              confidence: resolution.confidence,
            }))
          : [];
      const existingSignature = catalogSignature(
        active.map((mapping) => ({
          variantId: mapping.variantId,
          source: mapping.source,
          confidence: Number(mapping.confidence),
        })),
      );
      if (existingSignature === catalogSignature(desired)) {
        return { state: resolution.state, changed: false };
      }

      const now = new Date();
      await tx.catalogItemVariantMapping.updateMany({
        where: { catalogItemId, validUntil: null, isMerchantConfirmed: false },
        data: { validUntil: now },
      });
      for (const mapping of desired) {
        await tx.catalogItemVariantMapping.create({
          data: {
            catalogItemId,
            variantId: mapping.variantId,
            source: mapping.source,
            confidence: mapping.confidence,
          },
        });
      }
      return { state: resolution.state, changed: true };
    });
  }

  async applyAutomaticAdResolution(adId: string, resolution: AdResolution) {
    return prisma.$transaction(async (tx) => {
      const [ad, active] = await Promise.all([
        tx.metaAd.findUnique({
          where: { id: adId },
          select: { targetScope: true, targetScopeConfidence: true },
        }),
        tx.adProductMapping.findMany({
          where: { metaAdId: adId, validUntil: null },
          select: {
            id: true,
            productId: true,
            variantId: true,
            catalogItemId: true,
            granularity: true,
            optionSelector: true,
            source: true,
            confidence: true,
            isMerchantConfirmed: true,
            landingUrl: true,
            providerProductId: true,
            providerProductGroupId: true,
          },
        }),
      ]);
      if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');

      const confirmed = active.filter((mapping) => mapping.isMerchantConfirmed);
      if (confirmed.length > 0) {
        const scope = deriveScopeFromMappings(confirmed);
        const changed = ad.targetScope !== scope || Number(ad.targetScopeConfidence ?? 0) !== 1;
        await tx.metaAd.update({
          where: { id: adId },
          data: {
            targetScope: scope,
            targetScopeConfidence: 1,
            targetScopeEvidence: {
              source: 'merchant_confirmation',
              mappingIds: confirmed.map((mapping) => mapping.id),
            },
          },
        });
        return { state: 'PRESERVED_CONFIRMED' as const, changed, scope };
      }

      const existingSignature = adSignature(
        active.map((mapping) => ({
          productId: mapping.productId,
          variantId: mapping.variantId,
          catalogItemId: mapping.catalogItemId,
          granularity: mapping.granularity,
          optionSelector: mapping.optionSelector,
          source: mapping.source,
          confidence: Number(mapping.confidence),
          landingUrl: mapping.landingUrl,
          providerProductId: mapping.providerProductId,
          providerProductGroupId: mapping.providerProductGroupId,
        })),
      );
      const mappingChanged = existingSignature !== adSignature(resolution.mappings);
      if (mappingChanged) {
        const now = new Date();
        await tx.adProductMapping.updateMany({
          where: { metaAdId: adId, validUntil: null, isMerchantConfirmed: false },
          data: { validUntil: now },
        });
        for (const mapping of resolution.mappings) {
          await tx.adProductMapping.create({
            data: {
              metaAdId: adId,
              productId: mapping.productId,
              variantId: mapping.variantId,
              catalogItemId: mapping.catalogItemId,
              granularity: mapping.granularity,
              optionSelector: jsonOrNull(mapping.optionSelector),
              source: mapping.source,
              confidence: mapping.confidence,
              evidenceJson: mapping.evidence as Prisma.InputJsonValue,
              landingUrl: mapping.landingUrl,
              providerProductId: mapping.providerProductId,
              providerProductGroupId: mapping.providerProductGroupId,
            },
          });
        }
      }

      const scopeChanged =
        ad.targetScope !== resolution.scope ||
        Number(ad.targetScopeConfidence ?? 0) !== resolution.confidence;
      await tx.metaAd.update({
        where: { id: adId },
        data: {
          targetScope: resolution.scope,
          targetScopeConfidence: resolution.confidence,
          targetScopeEvidence: resolution.evidence as Prisma.InputJsonValue,
        },
      });
      return {
        state: resolution.scope,
        changed: mappingChanged || scopeChanged,
        scope: resolution.scope,
      };
    });
  }

  async replaceManualCatalogMappings(storeId: string, metaProductItemId: string, variantIds: string[]) {
    return prisma.$transaction(async (tx) => {
      const [connection, item] = await Promise.all([
        tx.metaConnection.findUnique({
          where: { storeId },
          select: { selectedCatalogIds: true },
        }),
        tx.metaCatalogItem.findFirst({
          where: { metaProductItemId, deletedAt: null, catalog: { storeId } },
          select: { id: true, catalog: { select: { metaCatalogId: true } } },
        }),
      ]);
      if (!item || !connection?.selectedCatalogIds.includes(item.catalog.metaCatalogId)) {
        throw new AppError('Meta catalog item was not found', 404, 'META_CATALOG_ITEM_NOT_FOUND');
      }

      const uniqueVariantIds = [...new Set(variantIds)];
      const variants = await tx.productVariant.findMany({
        where: { id: { in: uniqueVariantIds }, storeId, deletedAt: null },
        select: { id: true },
      });
      if (variants.length !== uniqueVariantIds.length) {
        throw new AppError('One or more Shopify variants were not found', 400, 'SHOPIFY_VARIANT_NOT_FOUND');
      }

      const now = new Date();
      await tx.catalogItemVariantMapping.updateMany({
        where: { catalogItemId: item.id, validUntil: null },
        data: { validUntil: now },
      });
      for (const variant of variants) {
        await tx.catalogItemVariantMapping.create({
          data: {
            catalogItemId: item.id,
            variantId: variant.id,
            source: 'MANUAL',
            confidence: 1,
            isMerchantConfirmed: true,
          },
        });
      }
      return { metaProductItemId, variantIds: variants.map((variant) => variant.id) };
    });
  }

  async validateManualAdMappings(storeId: string, mappings: ManualAdMappingInput[]) {
    const productIds = [...new Set(mappings.map((mapping) => mapping.productId))];
    const products = await prisma.product.findMany({
      where: { id: { in: productIds }, storeId, deletedAt: null },
      select: {
        id: true,
        variants: {
          where: { deletedAt: null },
          select: { id: true, options: { select: { name: true, value: true } } },
        },
      },
    });
    if (products.length !== productIds.length) {
      throw new AppError('One or more Shopify products were not found', 400, 'SHOPIFY_PRODUCT_NOT_FOUND');
    }

    const byId = new Map(products.map((product) => [product.id, product]));
    for (const mapping of mappings) {
      const product = byId.get(mapping.productId)!;
      if (mapping.granularity === 'VARIANT') {
        if (!mapping.variantId || !product.variants.some((variant) => variant.id === mapping.variantId)) {
          throw new AppError(
            'Manual variant mapping does not belong to the selected product',
            400,
            'INVALID_VARIANT_MAPPING',
          );
        }
      }
      if (mapping.granularity === 'PRODUCT_OPTION') {
        const entries = Object.entries(mapping.optionSelector ?? {});
        if (entries.length === 0 || entries.some(([, values]) => values.length === 0)) {
          throw new AppError('Product-option mapping requires options', 400, 'INVALID_OPTION_MAPPING');
        }
        const matches = product.variants.filter((variant) =>
          entries.every(([name, values]) =>
            variant.options.some((option) => option.name === name && values.includes(option.value)),
          ),
        );
        if (matches.length === 0) {
          throw new AppError(
            'Product-option mapping does not match a Shopify variant',
            400,
            'INVALID_OPTION_MAPPING',
          );
        }
      }
    }
  }

  async replaceManualAdMappings(
    storeId: string,
    metaAdId: string,
    mappings: ManualAdMappingInput[],
  ) {
    await this.validateManualAdMappings(storeId, mappings);
    return prisma.$transaction(async (tx) => {
      const ad = await tx.metaAd.findFirst({
        where: { metaAdId, deletedAt: null, adAccount: { storeId } },
        select: { id: true },
      });
      if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');

      const now = new Date();
      await tx.adProductMapping.updateMany({
        where: { metaAdId: ad.id, validUntil: null },
        data: { validUntil: now },
      });
      for (const mapping of mappings) {
        await tx.adProductMapping.create({
          data: {
            metaAdId: ad.id,
            productId: mapping.productId,
            variantId: mapping.granularity === 'VARIANT' ? (mapping.variantId ?? null) : null,
            granularity: mapping.granularity,
            optionSelector: jsonOrNull(
              mapping.granularity === 'PRODUCT_OPTION' ? mapping.optionSelector : null,
            ),
            source: 'MANUAL',
            confidence: 1,
            isMerchantConfirmed: true,
            evidenceJson: { source: 'merchant_manual_mapping' },
          },
        });
      }
      const scope = deriveScopeFromMappings(mappings);
      await tx.metaAd.update({
        where: { id: ad.id },
        data: {
          targetScope: scope,
          targetScopeConfidence: 1,
          targetScopeEvidence: { source: 'merchant_manual_mapping' },
        },
      });
      return { metaAdId, scope, mappings };
    });
  }

  async confirmCurrentAdMappings(storeId: string, metaAdId: string) {
    return prisma.$transaction(async (tx) => {
      const ad = await tx.metaAd.findFirst({
        where: { metaAdId, deletedAt: null, adAccount: { storeId } },
        select: {
          id: true,
          productMappings: {
            where: { validUntil: null },
            select: { id: true, productId: true, variantId: true, granularity: true },
          },
        },
      });
      if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
      if (ad.productMappings.length === 0) {
        throw new AppError('Meta ad has no mapping to confirm', 409, 'META_MAPPING_NOT_FOUND');
      }

      await tx.adProductMapping.updateMany({
        where: { metaAdId: ad.id, validUntil: null },
        data: { isMerchantConfirmed: true, confidence: 1 },
      });
      const scope = deriveScopeFromMappings(ad.productMappings);
      await tx.metaAd.update({
        where: { id: ad.id },
        data: {
          targetScope: scope,
          targetScopeConfidence: 1,
          targetScopeEvidence: {
            source: 'merchant_confirmation',
            mappingIds: ad.productMappings.map((mapping) => mapping.id),
          },
        },
      });
      return { metaAdId, scope, confirmed: ad.productMappings.length };
    });
  }

  async listAdMappings(storeId: string, page: number, limit: number) {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    const selected = connection?.selectedAdAccountIds ?? [];
    const where = {
      deletedAt: null,
      adAccount: { storeId, metaAccountId: { in: selected } },
    } satisfies Prisma.MetaAdWhereInput;
    return prisma.$transaction([
      prisma.metaAd.findMany({
        where,
        select: {
          metaAdId: true,
          name: true,
          targetScope: true,
          targetScopeConfidence: true,
          targetScopeEvidence: true,
          effectiveStatus: true,
          creative: { select: { thumbnailUrl: true, title: true, productSetId: true } },
          productMappings: {
            where: { validUntil: null },
            select: {
              id: true,
              granularity: true,
              optionSelector: true,
              source: true,
              confidence: true,
              evidenceJson: true,
              landingUrl: true,
              isMerchantConfirmed: true,
              product: { select: { id: true, shopifyProductId: true, title: true, handle: true } },
              variant: { select: { id: true, shopifyVariantId: true, title: true, sku: true } },
              catalogItem: { select: { metaProductItemId: true, retailerId: true, name: true } },
            },
          },
        },
        orderBy: [{ targetScope: 'asc' }, { name: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.metaAd.count({ where }),
    ]).then(([items, total]) => ({ items, total }));
  }

  async mappingSummary(storeId: string) {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    const selected = connection?.selectedAdAccountIds ?? [];
    const adWhere = {
      deletedAt: null,
      adAccount: { storeId, metaAccountId: { in: selected } },
    } satisfies Prisma.MetaAdWhereInput;
    const [rows, confirmed] = await Promise.all([
      prisma.metaAd.groupBy({
        by: ['targetScope'],
        where: adWhere,
        _count: { _all: true },
      }),
      prisma.adProductMapping.count({
        where: {
          validUntil: null,
          isMerchantConfirmed: true,
          ad: adWhere,
        },
      }),
    ]);
    return {
      totalAds: rows.reduce((sum, row) => sum + row._count._all, 0),
      scopes: Object.fromEntries(rows.map((row) => [row.targetScope, row._count._all])),
      merchantConfirmedMappings: confirmed,
    };
  }
}
