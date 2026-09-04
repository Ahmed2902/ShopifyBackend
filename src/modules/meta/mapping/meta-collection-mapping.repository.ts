import { Prisma } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { deriveScopeFromMappings } from './meta-mapping.resolver.js';
import type { AdResolution } from './meta-mapping.types.js';

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

function productSignature(
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

function collectionSignature(
  mappings: Array<{
    collectionId: string;
    source: string;
    confidence: number;
    landingUrl: string | null;
  }>,
): string {
  return mappings
    .map(
      (mapping) =>
        `${mapping.collectionId}|${mapping.source}|${mapping.confidence.toFixed(4)}|${mapping.landingUrl ?? ''}`,
    )
    .sort()
    .join(';');
}

async function lockMetaAd(tx: Prisma.TransactionClient, adId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "MetaAd"
    WHERE "id" = ${adId}::uuid
    FOR UPDATE
  `;
  if (rows.length === 0) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
}

export interface ResolvedCollectionTarget {
  id: string;
  shopifyCollectionId: string;
  title: string;
  handle: string | null;
}

export interface ManualProductTargetInput {
  productId: string;
  variantId?: string | null;
  granularity: 'PRODUCT' | 'PRODUCT_OPTION' | 'VARIANT';
  optionSelector?: Record<string, string[]> | null;
}

const mappingSelect = {
  id: true,
  metaAdId: true,
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
    },
  },
} as const;

export class MetaCollectionMappingRepository {
  getActiveForAds(adIds: string[]) {
    if (adIds.length === 0) return Promise.resolve([]);
    return prisma.adCollectionMapping.findMany({
      where: {
        metaAdId: { in: adIds },
        validUntil: null,
        collection: { deletedAt: null },
      },
      select: mappingSelect,
      orderBy: [{ metaAdId: 'asc' }, { collectionId: 'asc' }],
    });
  }

  getActiveForExternalAds(storeId: string, metaAdIds: string[]) {
    if (metaAdIds.length === 0) return Promise.resolve([]);
    return prisma.adCollectionMapping.findMany({
      where: {
        validUntil: null,
        collection: { deletedAt: null },
        ad: { metaAdId: { in: metaAdIds }, adAccount: { storeId } },
      },
      select: {
        ...mappingSelect,
        ad: { select: { metaAdId: true } },
      },
      orderBy: [{ metaAdId: 'asc' }, { collectionId: 'asc' }],
    });
  }

  getStoreCollections(storeId: string) {
    return prisma.collection.findMany({
      where: { storeId, deletedAt: null },
      select: {
        id: true,
        shopifyCollectionId: true,
        title: true,
        handle: true,
      },
    });
  }

  async applyAutomaticAdResolution(input: {
    adId: string;
    resolution: AdResolution;
    collection: ResolvedCollectionTarget | null;
    landingUrl: string | null;
  }) {
    return prisma.$transaction(async (tx) => {
      await lockMetaAd(tx, input.adId);
      const [ad, activeProducts, activeCollections] = await Promise.all([
        tx.metaAd.findUnique({
          where: { id: input.adId },
          select: { targetScope: true, targetScopeConfidence: true },
        }),
        tx.adProductMapping.findMany({
          where: { metaAdId: input.adId, validUntil: null },
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
            product: { select: { deletedAt: true } },
            variant: { select: { deletedAt: true } },
          },
        }),
        tx.adCollectionMapping.findMany({
          where: { metaAdId: input.adId, validUntil: null },
          select: {
            id: true,
            collectionId: true,
            source: true,
            confidence: true,
            landingUrl: true,
            isMerchantConfirmed: true,
            collection: { select: { deletedAt: true } },
          },
        }),
      ]);
      if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');

      const productTargetIsCurrent = (mapping: (typeof activeProducts)[number]) =>
        mapping.product.deletedAt === null &&
        (mapping.granularity !== 'VARIANT' || mapping.variant?.deletedAt === null);

      const confirmedCollections = activeCollections.filter(
        (mapping) => mapping.isMerchantConfirmed && mapping.collection.deletedAt === null,
      );
      if (confirmedCollections.length > 0) {
        const now = new Date();
        const [closedProducts, closedStaleCollections] = await Promise.all([
          tx.adProductMapping.updateMany({
            where: { metaAdId: input.adId, validUntil: null },
            data: { validUntil: now },
          }),
          tx.adCollectionMapping.updateMany({
            where: {
              id: {
                in: activeCollections
                  .filter(
                    (mapping) =>
                      !mapping.isMerchantConfirmed || mapping.collection.deletedAt !== null,
                  )
                  .map((mapping) => mapping.id),
              },
            },
            data: { validUntil: now },
          }),
        ]);
        const scopeChanged =
          ad.targetScope !== 'COLLECTION' || Number(ad.targetScopeConfidence ?? 0) !== 1;
        await tx.metaAd.update({
          where: { id: input.adId },
          data: {
            targetScope: 'COLLECTION',
            targetScopeConfidence: 1,
            targetScopeEvidence: {
              source: 'merchant_confirmation',
              collectionIds: confirmedCollections.map((mapping) => mapping.collectionId),
              mappingIds: confirmedCollections.map((mapping) => mapping.id),
            },
          },
        });
        return {
          state: 'PRESERVED_CONFIRMED' as const,
          changed: closedProducts.count > 0 || closedStaleCollections.count > 0 || scopeChanged,
          scope: 'COLLECTION' as const,
        };
      }

      const confirmedProducts = activeProducts.filter(
        (mapping) => mapping.isMerchantConfirmed && productTargetIsCurrent(mapping),
      );
      if (confirmedProducts.length > 0) {
        const now = new Date();
        const [closedCollections, closedOtherProducts] = await Promise.all([
          tx.adCollectionMapping.updateMany({
            where: { metaAdId: input.adId, validUntil: null },
            data: { validUntil: now },
          }),
          tx.adProductMapping.updateMany({
            where: {
              id: {
                in: activeProducts
                  .filter(
                    (mapping) =>
                      !mapping.isMerchantConfirmed || !productTargetIsCurrent(mapping),
                  )
                  .map((mapping) => mapping.id),
              },
            },
            data: { validUntil: now },
          }),
        ]);
        const scope = deriveScopeFromMappings(confirmedProducts);
        const scopeChanged = ad.targetScope !== scope || Number(ad.targetScopeConfidence ?? 0) !== 1;
        await tx.metaAd.update({
          where: { id: input.adId },
          data: {
            targetScope: scope,
            targetScopeConfidence: 1,
            targetScopeEvidence: {
              source: 'merchant_confirmation',
              mappingIds: confirmedProducts.map((mapping) => mapping.id),
            },
          },
        });
        return {
          state: 'PRESERVED_CONFIRMED' as const,
          changed: closedCollections.count > 0 || closedOtherProducts.count > 0 || scopeChanged,
          scope,
        };
      }

      const desiredProducts = input.resolution.mappings;
      const existingProductSignature = productSignature(
        activeProducts.map((mapping) => ({
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
      const productChanged = existingProductSignature !== productSignature(desiredProducts);

      const desiredCollections =
        input.resolution.scope === 'COLLECTION' && input.collection
          ? [
              {
                collectionId: input.collection.id,
                source: 'URL' as const,
                confidence: input.resolution.confidence,
                landingUrl: input.landingUrl,
              },
            ]
          : [];
      const existingCollectionSignature = collectionSignature(
        activeCollections.map((mapping) => ({
          collectionId: mapping.collectionId,
          source: mapping.source,
          confidence: Number(mapping.confidence),
          landingUrl: mapping.landingUrl,
        })),
      );
      const collectionChanged =
        existingCollectionSignature !== collectionSignature(desiredCollections);

      const now = new Date();
      if (productChanged) {
        await tx.adProductMapping.updateMany({
          where: { metaAdId: input.adId, validUntil: null },
          data: { validUntil: now },
        });
        for (const mapping of desiredProducts) {
          await tx.adProductMapping.create({
            data: {
              metaAdId: input.adId,
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

      if (collectionChanged) {
        await tx.adCollectionMapping.updateMany({
          where: { metaAdId: input.adId, validUntil: null },
          data: { validUntil: now },
        });
        for (const mapping of desiredCollections) {
          await tx.adCollectionMapping.create({
            data: {
              metaAdId: input.adId,
              collectionId: mapping.collectionId,
              source: mapping.source,
              confidence: mapping.confidence,
              landingUrl: mapping.landingUrl,
              evidenceJson: input.resolution.evidence as Prisma.InputJsonValue,
            },
          });
        }
      }

      const scopeChanged =
        ad.targetScope !== input.resolution.scope ||
        Number(ad.targetScopeConfidence ?? 0) !== input.resolution.confidence;
      await tx.metaAd.update({
        where: { id: input.adId },
        data: {
          targetScope: input.resolution.scope,
          targetScopeConfidence: input.resolution.confidence,
          targetScopeEvidence: input.resolution.evidence as Prisma.InputJsonValue,
        },
      });

      return {
        state: input.resolution.scope,
        changed: productChanged || collectionChanged || scopeChanged,
        scope: input.resolution.scope,
      };
    });
  }

  async replaceManualProductMappings(
    storeId: string,
    metaAdId: string,
    mappings: ManualProductTargetInput[],
  ) {
    return prisma.$transaction(async (tx) => {
      const ad = await tx.metaAd.findFirst({
        where: { metaAdId, deletedAt: null, adAccount: { storeId } },
        select: { id: true },
      });
      if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
      await lockMetaAd(tx, ad.id);

      const now = new Date();
      await tx.adProductMapping.updateMany({
        where: { metaAdId: ad.id, validUntil: null },
        data: { validUntil: now },
      });
      await tx.adCollectionMapping.updateMany({
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

      const scope = deriveScopeFromMappings(
        mappings.map((mapping) => ({
          productId: mapping.productId,
          variantId: mapping.variantId ?? null,
          granularity: mapping.granularity,
        })),
      );
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

  async replaceManualMappings(storeId: string, metaAdId: string, collectionIds: string[]) {
    const uniqueIds = [...new Set(collectionIds)];
    const collections = await prisma.collection.findMany({
      where: { id: { in: uniqueIds }, storeId, deletedAt: null },
      select: { id: true, shopifyCollectionId: true, title: true, handle: true },
    });
    if (collections.length !== uniqueIds.length) {
      throw new AppError(
        'One or more Shopify collections were not found',
        400,
        'SHOPIFY_COLLECTION_NOT_FOUND',
      );
    }

    return prisma.$transaction(async (tx) => {
      const ad = await tx.metaAd.findFirst({
        where: { metaAdId, deletedAt: null, adAccount: { storeId } },
        select: { id: true },
      });
      if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
      await lockMetaAd(tx, ad.id);

      const now = new Date();
      await tx.adProductMapping.updateMany({
        where: { metaAdId: ad.id, validUntil: null },
        data: { validUntil: now },
      });
      await tx.adCollectionMapping.updateMany({
        where: { metaAdId: ad.id, validUntil: null },
        data: { validUntil: now },
      });

      for (const collection of collections) {
        await tx.adCollectionMapping.create({
          data: {
            metaAdId: ad.id,
            collectionId: collection.id,
            source: 'MANUAL',
            confidence: 1,
            isMerchantConfirmed: true,
            evidenceJson: {
              source: 'merchant_manual_collection_mapping',
              shopifyCollectionId: collection.shopifyCollectionId,
              handle: collection.handle,
            },
          },
        });
      }

      await tx.metaAd.update({
        where: { id: ad.id },
        data: {
          targetScope: 'COLLECTION',
          targetScopeConfidence: 1,
          targetScopeEvidence: {
            source: 'merchant_manual_collection_mapping',
            collectionIds: collections.map((collection) => collection.id),
          },
        },
      });

      return {
        metaAdId,
        scope: 'COLLECTION' as const,
        collections,
        merchantConfirmed: true,
      };
    });
  }

  async confirmCurrentMappings(storeId: string, metaAdId: string) {
    return prisma.$transaction(async (tx) => {
      const found = await tx.metaAd.findFirst({
        where: { metaAdId, deletedAt: null, adAccount: { storeId } },
        select: { id: true },
      });
      if (!found) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
      await lockMetaAd(tx, found.id);

      const ad = await tx.metaAd.findUnique({
        where: { id: found.id },
        select: {
          id: true,
          targetScope: true,
          productMappings: {
            where: { validUntil: null },
            select: {
              id: true,
              productId: true,
              variantId: true,
              granularity: true,
              product: { select: { deletedAt: true } },
              variant: { select: { deletedAt: true } },
            },
          },
          collectionMappings: {
            where: { validUntil: null },
            select: {
              id: true,
              collectionId: true,
              collection: { select: { deletedAt: true } },
            },
          },
        },
      });
      if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');

      const validCollections = ad.collectionMappings.filter(
        (mapping) => mapping.collection.deletedAt === null,
      );
      const validProducts = ad.productMappings.filter(
        (mapping) =>
          mapping.product.deletedAt === null &&
          (mapping.granularity !== 'VARIANT' || mapping.variant?.deletedAt === null),
      );

      if (ad.targetScope === 'COLLECTION' && validCollections.length > 0) {
        const now = new Date();
        await tx.adProductMapping.updateMany({
          where: { metaAdId: ad.id, validUntil: null },
          data: { validUntil: now },
        });
        await tx.adCollectionMapping.updateMany({
          where: {
            id: {
              in: ad.collectionMappings
                .filter((mapping) => mapping.collection.deletedAt !== null)
                .map((mapping) => mapping.id),
            },
          },
          data: { validUntil: now },
        });
        await tx.adCollectionMapping.updateMany({
          where: { id: { in: validCollections.map((mapping) => mapping.id) } },
          data: { confidence: 1, isMerchantConfirmed: true },
        });
        await tx.metaAd.update({
          where: { id: ad.id },
          data: {
            targetScope: 'COLLECTION',
            targetScopeConfidence: 1,
            targetScopeEvidence: {
              source: 'merchant_confirmation',
              collectionIds: validCollections.map((mapping) => mapping.collectionId),
              mappingIds: validCollections.map((mapping) => mapping.id),
            },
          },
        });
        return { metaAdId, scope: 'COLLECTION' as const, confirmed: validCollections.length };
      }

      if (validProducts.length > 0) {
        const now = new Date();
        await tx.adCollectionMapping.updateMany({
          where: { metaAdId: ad.id, validUntil: null },
          data: { validUntil: now },
        });
        await tx.adProductMapping.updateMany({
          where: {
            id: {
              in: ad.productMappings
                .filter((mapping) => !validProducts.some((valid) => valid.id === mapping.id))
                .map((mapping) => mapping.id),
            },
          },
          data: { validUntil: now },
        });
        await tx.adProductMapping.updateMany({
          where: { id: { in: validProducts.map((mapping) => mapping.id) } },
          data: { isMerchantConfirmed: true, confidence: 1 },
        });
        const scope = deriveScopeFromMappings(validProducts);
        await tx.metaAd.update({
          where: { id: ad.id },
          data: {
            targetScope: scope,
            targetScopeConfidence: 1,
            targetScopeEvidence: {
              source: 'merchant_confirmation',
              mappingIds: validProducts.map((mapping) => mapping.id),
            },
          },
        });
        return { metaAdId, scope, confirmed: validProducts.length };
      }

      const now = new Date();
      await Promise.all([
        tx.adProductMapping.updateMany({
          where: { metaAdId: ad.id, validUntil: null },
          data: { validUntil: now },
        }),
        tx.adCollectionMapping.updateMany({
          where: { metaAdId: ad.id, validUntil: null },
          data: { validUntil: now },
        }),
      ]);
      throw new AppError('Meta ad has no current mapping to confirm', 409, 'META_MAPPING_NOT_FOUND');
    });
  }

  async countConfirmedForStore(storeId: string) {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    const selectedAccountIds = connection?.selectedAdAccountIds ?? [];
    if (selectedAccountIds.length === 0) return 0;
    return prisma.adCollectionMapping.count({
      where: {
        validUntil: null,
        isMerchantConfirmed: true,
        collection: { deletedAt: null },
        ad: {
          deletedAt: null,
          adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
        },
      },
    });
  }
}
