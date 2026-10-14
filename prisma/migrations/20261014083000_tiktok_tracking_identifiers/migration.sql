-- Nullable URL identifiers only; no historical attribution is inferred.
ALTER TABLE "StorefrontEvent" ADD COLUMN "tiktokCampaignExternalId" VARCHAR(128), ADD COLUMN "tiktokAdGroupExternalId" VARCHAR(128), ADD COLUMN "tiktokAdExternalId" VARCHAR(128), ADD COLUMN "tiktokCreativeExternalId" VARCHAR(128);
ALTER TABLE "StorefrontSessionTouch" ADD COLUMN "tiktokCampaignExternalId" VARCHAR(128), ADD COLUMN "tiktokAdGroupExternalId" VARCHAR(128), ADD COLUMN "tiktokAdExternalId" VARCHAR(128), ADD COLUMN "tiktokCreativeExternalId" VARCHAR(128);
