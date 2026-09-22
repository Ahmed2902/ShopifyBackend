import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

/**
 * Transitional set-based projection from provider-native persistence into the canonical paid-media
 * model. Meta keeps its mature native sync path during the migration window; a completed provider
 * snapshot is projected atomically so canonical reads never observe a half-written hierarchy.
 */
export class AdvertisingProjectionRepository {
  projectMetaHierarchy(adAccountId: string) {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingAccount" (
          "id", "storeId", "provider", "providerEntityId", "name", "status", "currency", "timezone",
          "providerData", "rawJson", "lastSyncedAt", "createdAt", "updatedAt"
        )
        SELECT
          a."id", a."storeId", 'META'::"AdvertisingProvider", a."metaAccountId", a."name", a."status",
          a."currency", a."timezoneName",
          jsonb_strip_nulls(jsonb_build_object(
            'timezoneId', a."timezoneId",
            'timezoneOffsetHours', a."timezoneOffsetHours",
            'amountSpentMinor', a."amountSpentMinor"::text,
            'balanceMinor', a."balanceMinor"::text,
            'spendCapMinor', a."spendCapMinor"::text
          )),
          a."rawJson", a."lastSyncedAt", a."createdAt", a."updatedAt"
        FROM "MetaAdAccount" a
        WHERE a."id" = ${adAccountId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "storeId" = EXCLUDED."storeId",
          "provider" = EXCLUDED."provider",
          "providerEntityId" = EXCLUDED."providerEntityId",
          "name" = EXCLUDED."name",
          "status" = EXCLUDED."status",
          "currency" = EXCLUDED."currency",
          "timezone" = EXCLUDED."timezone",
          "providerData" = EXCLUDED."providerData",
          "rawJson" = EXCLUDED."rawJson",
          "lastSyncedAt" = EXCLUDED."lastSyncedAt",
          "updatedAt" = EXCLUDED."updatedAt"
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingCampaign" (
          "id", "accountId", "providerEntityId", "name", "status", "effectiveStatus", "objective",
          "campaignType", "budgetAmount", "budgetMode", "bidStrategy", "startsAt", "endsAt",
          "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
        )
        SELECT
          c."id", c."adAccountId", c."metaCampaignId", c."name", c."configuredStatus", c."effectiveStatus",
          c."objective", c."buyingType", NULL, NULL, c."bidStrategy", c."startTime", c."stopTime",
          jsonb_strip_nulls(jsonb_build_object(
            'status', c."status",
            'dailyBudgetMinor', c."dailyBudgetMinor"::text,
            'lifetimeBudgetMinor', c."lifetimeBudgetMinor"::text,
            'budgetRemainingMinor', c."budgetRemainingMinor"::text,
            'spendCapMinor', c."spendCapMinor"::text,
            'promotedObject', c."promotedObject"
          )),
          c."rawJson", c."metaCreatedAt", c."metaUpdatedAt", c."deletedAt", c."createdAt", c."updatedAt"
        FROM "MetaCampaign" c
        WHERE c."adAccountId" = ${adAccountId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "accountId" = EXCLUDED."accountId",
          "providerEntityId" = EXCLUDED."providerEntityId",
          "name" = EXCLUDED."name",
          "status" = EXCLUDED."status",
          "effectiveStatus" = EXCLUDED."effectiveStatus",
          "objective" = EXCLUDED."objective",
          "campaignType" = EXCLUDED."campaignType",
          "budgetAmount" = EXCLUDED."budgetAmount",
          "budgetMode" = EXCLUDED."budgetMode",
          "bidStrategy" = EXCLUDED."bidStrategy",
          "startsAt" = EXCLUDED."startsAt",
          "endsAt" = EXCLUDED."endsAt",
          "providerData" = EXCLUDED."providerData",
          "rawJson" = EXCLUDED."rawJson",
          "providerCreatedAt" = EXCLUDED."providerCreatedAt",
          "providerUpdatedAt" = EXCLUDED."providerUpdatedAt",
          "deletedAt" = EXCLUDED."deletedAt",
          "updatedAt" = EXCLUDED."updatedAt"
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingGroup" (
          "id", "accountId", "campaignId", "providerEntityId", "kind", "name", "status", "effectiveStatus",
          "optimizationGoal", "billingEvent", "bidStrategy", "bidAmount", "budgetAmount", "budgetMode", "targeting",
          "startsAt", "endsAt", "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
        )
        SELECT
          g."id", g."adAccountId", g."campaignId", g."metaAdSetId", 'AD_SET'::"AdvertisingGroupKind", g."name",
          g."configuredStatus", g."effectiveStatus", g."optimizationGoal", g."billingEvent", g."bidStrategy", NULL, NULL, NULL,
          g."targeting", g."startTime", g."endTime",
          jsonb_strip_nulls(jsonb_build_object(
            'status', g."status",
            'dailyBudgetMinor', g."dailyBudgetMinor"::text,
            'lifetimeBudgetMinor', g."lifetimeBudgetMinor"::text,
            'budgetRemainingMinor', g."budgetRemainingMinor"::text,
            'dailySpendCapMinor', g."dailySpendCapMinor"::text,
            'lifetimeSpendCapMinor', g."lifetimeSpendCapMinor"::text,
            'bidAmountMinor', g."bidAmountMinor"::text,
            'bidConstraints', g."bidConstraints",
            'destinationType', g."destinationType",
            'isDynamicCreative', g."isDynamicCreative",
            'promotedObject', g."promotedObject",
            'attributionSpec', g."attributionSpec",
            'learningStageInfo', g."learningStageInfo"
          )),
          g."rawJson", g."metaCreatedAt", g."metaUpdatedAt", g."deletedAt", g."createdAt", g."updatedAt"
        FROM "MetaAdSet" g
        WHERE g."adAccountId" = ${adAccountId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "accountId" = EXCLUDED."accountId",
          "campaignId" = EXCLUDED."campaignId",
          "providerEntityId" = EXCLUDED."providerEntityId",
          "kind" = EXCLUDED."kind",
          "name" = EXCLUDED."name",
          "status" = EXCLUDED."status",
          "effectiveStatus" = EXCLUDED."effectiveStatus",
          "optimizationGoal" = EXCLUDED."optimizationGoal",
          "billingEvent" = EXCLUDED."billingEvent",
          "bidStrategy" = EXCLUDED."bidStrategy",
          "bidAmount" = EXCLUDED."bidAmount",
          "budgetAmount" = EXCLUDED."budgetAmount",
          "budgetMode" = EXCLUDED."budgetMode",
          "targeting" = EXCLUDED."targeting",
          "startsAt" = EXCLUDED."startsAt",
          "endsAt" = EXCLUDED."endsAt",
          "providerData" = EXCLUDED."providerData",
          "rawJson" = EXCLUDED."rawJson",
          "providerCreatedAt" = EXCLUDED."providerCreatedAt",
          "providerUpdatedAt" = EXCLUDED."providerUpdatedAt",
          "deletedAt" = EXCLUDED."deletedAt",
          "updatedAt" = EXCLUDED."updatedAt"
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingCreative" (
          "id", "accountId", "providerEntityId", "name", "title", "body", "callToActionType", "imageUrl",
          "thumbnailUrl", "videoId", "linkUrl", "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt",
          "deletedAt", "createdAt", "updatedAt"
        )
        SELECT
          c."id", c."adAccountId", c."metaCreativeId", c."name", c."title", c."body", c."callToActionType",
          c."imageUrl", c."thumbnailUrl", c."videoId", COALESCE(c."linkUrl", c."objectUrl"),
          jsonb_strip_nulls(jsonb_build_object(
            'callToAction', c."callToAction",
            'linkDeepLinkUrl', c."linkDeepLinkUrl",
            'objectUrl', c."objectUrl",
            'objectStoryId', c."objectStoryId",
            'effectiveObjectStoryId', c."effectiveObjectStoryId",
            'effectiveInstagramMediaId', c."effectiveInstagramMediaId",
            'objectStorySpec', c."objectStorySpec",
            'productSetId', c."productSetId",
            'productData', c."productData",
            'assetFeedSpec', c."assetFeedSpec",
            'degreesOfFreedomSpec', c."degreesOfFreedomSpec",
            'resolvedDestinationUrls', c."resolvedDestinationUrls",
            'templateUrl', c."templateUrl",
            'templateUrlSpec', c."templateUrlSpec",
            'urlTags', c."urlTags",
            'instagramPermalinkUrl', c."instagramPermalinkUrl"
          )),
          c."rawJson", c."metaCreatedAt", c."metaUpdatedAt", c."deletedAt", c."createdAt", c."updatedAt"
        FROM "MetaCreative" c
        WHERE c."adAccountId" = ${adAccountId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "accountId" = EXCLUDED."accountId",
          "providerEntityId" = EXCLUDED."providerEntityId",
          "name" = EXCLUDED."name",
          "title" = EXCLUDED."title",
          "body" = EXCLUDED."body",
          "callToActionType" = EXCLUDED."callToActionType",
          "imageUrl" = EXCLUDED."imageUrl",
          "thumbnailUrl" = EXCLUDED."thumbnailUrl",
          "videoId" = EXCLUDED."videoId",
          "linkUrl" = EXCLUDED."linkUrl",
          "providerData" = EXCLUDED."providerData",
          "rawJson" = EXCLUDED."rawJson",
          "providerCreatedAt" = EXCLUDED."providerCreatedAt",
          "providerUpdatedAt" = EXCLUDED."providerUpdatedAt",
          "deletedAt" = EXCLUDED."deletedAt",
          "updatedAt" = EXCLUDED."updatedAt"
      `);

      await tx.$executeRaw(Prisma.sql`
        INSERT INTO "AdvertisingAd" (
          "id", "accountId", "campaignId", "groupId", "creativeId", "providerEntityId", "name", "status", "effectiveStatus",
          "format", "landingPageUrl", "targetScope", "targetScopeConfidence", "targetScopeEvidence", "providerData", "rawJson",
          "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
        )
        SELECT
          a."id", a."adAccountId", a."campaignId", a."adSetId", a."creativeId", a."metaAdId", a."name",
          a."configuredStatus", a."effectiveStatus", NULL, COALESCE(c."linkUrl", c."objectUrl"),
          a."targetScope"::text::"AdvertisingTargetScope", a."targetScopeConfidence", a."targetScopeEvidence",
          jsonb_strip_nulls(jsonb_build_object(
            'conversionDomain', a."conversionDomain",
            'sourceAdId', a."sourceAdId",
            'placement', a."placement",
            'trackingSpec', a."trackingSpec",
            'conversionSpec', a."conversionSpec",
            'recommendations', a."recommendations",
            'issuesInfo', a."issuesInfo",
            'adLabels', a."adLabels"
          )),
          a."rawJson", a."metaCreatedAt", a."metaUpdatedAt", a."deletedAt", a."createdAt", a."updatedAt"
        FROM "MetaAd" a
        LEFT JOIN "MetaCreative" c ON c."id" = a."creativeId"
        WHERE a."adAccountId" = ${adAccountId}::uuid
        ON CONFLICT ("id") DO UPDATE SET
          "accountId" = EXCLUDED."accountId",
          "campaignId" = EXCLUDED."campaignId",
          "groupId" = EXCLUDED."groupId",
          "creativeId" = EXCLUDED."creativeId",
          "providerEntityId" = EXCLUDED."providerEntityId",
          "name" = EXCLUDED."name",
          "status" = EXCLUDED."status",
          "effectiveStatus" = EXCLUDED."effectiveStatus",
          "format" = EXCLUDED."format",
          "landingPageUrl" = EXCLUDED."landingPageUrl",
          "targetScope" = EXCLUDED."targetScope",
          "targetScopeConfidence" = EXCLUDED."targetScopeConfidence",
          "targetScopeEvidence" = EXCLUDED."targetScopeEvidence",
          "providerData" = EXCLUDED."providerData",
          "rawJson" = EXCLUDED."rawJson",
          "providerCreatedAt" = EXCLUDED."providerCreatedAt",
          "providerUpdatedAt" = EXCLUDED."providerUpdatedAt",
          "deletedAt" = EXCLUDED."deletedAt",
          "updatedAt" = EXCLUDED."updatedAt"
      `);
    });
  }
}

export const advertisingProjectionRepository = new AdvertisingProjectionRepository();
