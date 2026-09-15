import { Prisma, type PrismaClient } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { MetaCollectionMappingRepository } from './meta-collection-mapping.repository.js';

const adMappingSelect = {
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
} satisfies Prisma.MetaAdSelect;

type LookupDb = Pick<PrismaClient, 'metaConnection' | 'metaAd'>;
type CollectionLookup = Pick<MetaCollectionMappingRepository, 'getActiveForExternalAds'>;

/**
 * Exact point-read for a selected Meta ad mapping.
 *
 * This deliberately scopes the query through the store's selected ad accounts,
 * so a known Meta ad ID from another store/account cannot be used to bypass the
 * same provider-selection boundary enforced by the mapping queue.
 */
export class MetaAdMappingLookup {
  constructor(
    private readonly db: LookupDb = prisma,
    private readonly collections: CollectionLookup = new MetaCollectionMappingRepository(),
  ) {}

  async find(storeId: string, metaAdId: string) {
    const connection = await this.db.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    const selected = connection?.selectedAdAccountIds ?? [];

    const ad = await this.db.metaAd.findFirst({
      where: {
        metaAdId,
        deletedAt: null,
        adAccount: { storeId, metaAccountId: { in: selected } },
      },
      select: adMappingSelect,
    });
    if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');

    const collectionMappings = await this.collections.getActiveForExternalAds(storeId, [metaAdId]);

    return {
      ...ad,
      targetScopeConfidence:
        ad.targetScopeConfidence == null ? null : Number(ad.targetScopeConfidence),
      productMappings: ad.productMappings.map((mapping) => ({
        ...mapping,
        confidence: Number(mapping.confidence),
      })),
      collectionMappings: collectionMappings.map(({ ad: _ad, ...mapping }) => ({
        ...mapping,
        confidence: Number(mapping.confidence),
      })),
    };
  }
}

export const metaAdMappingLookup = new MetaAdMappingLookup();
