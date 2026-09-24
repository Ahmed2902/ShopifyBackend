-- Canonical paid-media rows are derived store data and must never block a physical store/account/ad
-- deletion (including Shopify privacy purge and test cleanup). Provider-native source tables retain
-- their existing deletion policy during the migration window.

ALTER TABLE "AdvertisingProductMapping" DROP CONSTRAINT "AdvertisingProductMapping_adId_fkey";
ALTER TABLE "AdvertisingCollectionMapping" DROP CONSTRAINT "AdvertisingCollectionMapping_adId_fkey";
ALTER TABLE "AdvertisingDailyMetric" DROP CONSTRAINT "AdvertisingDailyMetric_accountId_fkey";
ALTER TABLE "AdvertisingAd" DROP CONSTRAINT "AdvertisingAd_accountId_fkey";
ALTER TABLE "AdvertisingAd" DROP CONSTRAINT "AdvertisingAd_campaignId_fkey";
ALTER TABLE "AdvertisingCreative" DROP CONSTRAINT "AdvertisingCreative_accountId_fkey";
ALTER TABLE "AdvertisingGroup" DROP CONSTRAINT "AdvertisingGroup_accountId_fkey";
ALTER TABLE "AdvertisingGroup" DROP CONSTRAINT "AdvertisingGroup_campaignId_fkey";
ALTER TABLE "AdvertisingCampaign" DROP CONSTRAINT "AdvertisingCampaign_accountId_fkey";
ALTER TABLE "AdvertisingAccount" DROP CONSTRAINT "AdvertisingAccount_storeId_fkey";

ALTER TABLE "AdvertisingAccount"
  ADD CONSTRAINT "AdvertisingAccount_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdvertisingCampaign"
  ADD CONSTRAINT "AdvertisingCampaign_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdvertisingGroup"
  ADD CONSTRAINT "AdvertisingGroup_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdvertisingGroup"
  ADD CONSTRAINT "AdvertisingGroup_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "AdvertisingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdvertisingCreative"
  ADD CONSTRAINT "AdvertisingCreative_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdvertisingAd"
  ADD CONSTRAINT "AdvertisingAd_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdvertisingAd"
  ADD CONSTRAINT "AdvertisingAd_campaignId_fkey"
  FOREIGN KEY ("campaignId") REFERENCES "AdvertisingCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdvertisingDailyMetric"
  ADD CONSTRAINT "AdvertisingDailyMetric_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AdvertisingProductMapping"
  ADD CONSTRAINT "AdvertisingProductMapping_adId_fkey"
  FOREIGN KEY ("adId") REFERENCES "AdvertisingAd"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AdvertisingCollectionMapping"
  ADD CONSTRAINT "AdvertisingCollectionMapping_adId_fkey"
  FOREIGN KEY ("adId") REFERENCES "AdvertisingAd"("id") ON DELETE CASCADE ON UPDATE CASCADE;
