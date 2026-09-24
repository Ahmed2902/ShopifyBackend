-- Before the provider-neutral cutover, TikTokInsightDaily.conversionValue stored
-- total_complete_payment_rate. That field is a rate, not monetary conversion value.
-- Current TikTok ingestion writes native conversionValue = NULL, so a non-null native value is the
-- precise marker for rows written under the legacy contract. Preserve the old rate as provider
-- evidence, then fail closed on canonical monetary conversion value.
UPDATE "AdvertisingDailyMetric" AS metric
SET
  "providerMetrics" = COALESCE(metric."providerMetrics", '{}'::jsonb)
    || jsonb_build_object(
      'legacyTotalCompletePaymentRate', to_jsonb(native."conversionValue"),
      'conversionValueCorrection', 'TIKTOK_TOTAL_COMPLETE_PAYMENT_RATE_NOT_MONEY'
    ),
  "conversionValue" = NULL,
  "updatedAt" = CURRENT_TIMESTAMP
FROM "TikTokInsightDaily" AS native
INNER JOIN "AdvertisingAccount" AS account
  ON account."id" = native."advertiserDbId"
 AND account."provider" = 'TIKTOK'::"AdvertisingProvider"
WHERE metric."id" = native."id"
  AND metric."accountId" = native."advertiserDbId"
  AND metric."metricKey" = 'TIKTOK:' || native."insightKey"
  AND native."conversionValue" IS NOT NULL
  AND metric."conversionValue" IS NOT NULL;
