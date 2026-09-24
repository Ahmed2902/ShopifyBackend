import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Keeps canonical ad target scope and Shopify mapping history aligned with provider-native mapping
 * tables during the additive migration window. Mapping UUIDs are preserved so lifecycle/evidence
 * references remain stable when reads move to canonical persistence.
 */
export class AdvertisingMappingProjectionRepository {
  async projectMetaAd(adId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AdvertisingAd" canonical
        SET
          "targetScope" = native."targetScope"::text::"AdvertisingTargetScope",
          "targetScopeConfidence" = native."targetScopeConfidence",
          "targetScopeEvidence" = native."targetScopeEvidence",
          "updatedAt" = CURRENT_TIMESTAMP
        FROM "MetaAd" native
        WHERE native."id" = ${adId}::uuid
          AND canonical."id" = native."id"
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingProductMapping" (
          "id", "adId", "productId", "variantId", "granularity", "optionSelector", "source", "confidence",
          "evidenceJson", "landingUrl", "providerProductId", "providerProductGroupId", "providerData",
          "isMerchantConfirmed", "validFrom", "validUntil", "createdAt", "updatedAt"
        )
        SELECT
          m."id", m."metaAdId", m."productId", m."variantId", m."granularity", m."optionSelector", m."source", m."confidence",
          m."evidenceJson", m."landingUrl", m."providerProductId", m."providerProductGroupId",
          jsonb_strip_nulls(jsonb_build_object('legacyCatalogItemId', m."catalogItemId")),
          m."isMerchantConfirmed", m."validFrom", m."validUntil", m."createdAt", m."updatedAt"
        FROM "AdProductMapping" m
        WHERE m."metaAdId" = ${adId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "adId" = EXCLUDED."adId",
          "productId" = EXCLUDED."productId",
          "variantId" = EXCLUDED."variantId",
          "granularity" = EXCLUDED."granularity",
          "optionSelector" = EXCLUDED."optionSelector",
          "source" = EXCLUDED."source",
          "confidence" = EXCLUDED."confidence",
          "evidenceJson" = EXCLUDED."evidenceJson",
          "landingUrl" = EXCLUDED."landingUrl",
          "providerProductId" = EXCLUDED."providerProductId",
          "providerProductGroupId" = EXCLUDED."providerProductGroupId",
          "providerData" = EXCLUDED."providerData",
          "isMerchantConfirmed" = EXCLUDED."isMerchantConfirmed",
          "validFrom" = EXCLUDED."validFrom",
          "validUntil" = EXCLUDED."validUntil",
          "updatedAt" = EXCLUDED."updatedAt"
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingCollectionMapping" (
          "id", "adId", "collectionId", "source", "confidence", "evidenceJson", "landingUrl", "providerData",
          "isMerchantConfirmed", "validFrom", "validUntil", "createdAt", "updatedAt"
        )
        SELECT
          m."id", m."metaAdId", m."collectionId", m."source", m."confidence", m."evidenceJson", m."landingUrl", NULL,
          m."isMerchantConfirmed", m."validFrom", m."validUntil", m."createdAt", m."updatedAt"
        FROM "AdCollectionMapping" m
        WHERE m."metaAdId" = ${adId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "adId" = EXCLUDED."adId",
          "collectionId" = EXCLUDED."collectionId",
          "source" = EXCLUDED."source",
          "confidence" = EXCLUDED."confidence",
          "evidenceJson" = EXCLUDED."evidenceJson",
          "landingUrl" = EXCLUDED."landingUrl",
          "providerData" = EXCLUDED."providerData",
          "isMerchantConfirmed" = EXCLUDED."isMerchantConfirmed",
          "validFrom" = EXCLUDED."validFrom",
          "validUntil" = EXCLUDED."validUntil",
          "updatedAt" = EXCLUDED."updatedAt"
      `);
    });
  }

  async projectMetaAdByExternalId(storeId: string, providerEntityId: string) {
    const ad = await prisma.metaAd.findFirst({
      where: { metaAdId: providerEntityId, adAccount: { storeId } },
      select: { id: true },
    });
    if (!ad) return false;
    await this.projectMetaAd(ad.id);
    return true;
  }

  async projectTikTokAd(adId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "AdvertisingAd" canonical
        SET
          "targetScope" = native."targetScope"::text::"AdvertisingTargetScope",
          "targetScopeConfidence" = native."targetScopeConfidence",
          "targetScopeEvidence" = native."targetScopeEvidence",
          "updatedAt" = CURRENT_TIMESTAMP
        FROM "TikTokAd" native
        WHERE native."id" = ${adId}::uuid
          AND canonical."id" = native."id"
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingProductMapping" (
          "id", "adId", "productId", "variantId", "granularity", "optionSelector", "source", "confidence",
          "evidenceJson", "landingUrl", "providerProductId", "providerProductGroupId", "providerData",
          "isMerchantConfirmed", "validFrom", "validUntil", "createdAt", "updatedAt"
        )
        SELECT
          m."id", m."tiktokAdId", m."productId", m."variantId", m."granularity", m."optionSelector", m."source", m."confidence",
          m."evidenceJson", m."landingUrl", m."providerProductId", m."providerProductGroupId",
          jsonb_strip_nulls(jsonb_build_object('legacyCatalogItemId', m."catalogItemId")),
          m."isMerchantConfirmed", m."validFrom", m."validUntil", m."createdAt", m."updatedAt"
        FROM "TikTokAdProductMapping" m
        WHERE m."tiktokAdId" = ${adId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "adId" = EXCLUDED."adId",
          "productId" = EXCLUDED."productId",
          "variantId" = EXCLUDED."variantId",
          "granularity" = EXCLUDED."granularity",
          "optionSelector" = EXCLUDED."optionSelector",
          "source" = EXCLUDED."source",
          "confidence" = EXCLUDED."confidence",
          "evidenceJson" = EXCLUDED."evidenceJson",
          "landingUrl" = EXCLUDED."landingUrl",
          "providerProductId" = EXCLUDED."providerProductId",
          "providerProductGroupId" = EXCLUDED."providerProductGroupId",
          "providerData" = EXCLUDED."providerData",
          "isMerchantConfirmed" = EXCLUDED."isMerchantConfirmed",
          "validFrom" = EXCLUDED."validFrom",
          "validUntil" = EXCLUDED."validUntil",
          "updatedAt" = EXCLUDED."updatedAt"
      `);
    });
  }

  async projectTikTokAdByExternalId(storeId: string, providerEntityId: string) {
    const ad = await prisma.tikTokAd.findFirst({
      where: { tiktokAdId: providerEntityId, advertiser: { storeId } },
      select: { id: true },
    });
    if (!ad) return false;
    await this.projectTikTokAd(ad.id);
    return true;
  }
}

export const advertisingMappingProjectionRepository =
  new AdvertisingMappingProjectionRepository();
