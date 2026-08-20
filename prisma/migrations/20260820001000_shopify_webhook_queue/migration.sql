ALTER TABLE "WebhookDelivery"
  ADD COLUMN "processingStartedAt" TIMESTAMP(3),
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "updatedAt" TIMESTAMP(3);

UPDATE "WebhookDelivery"
SET "updatedAt" = COALESCE("receivedAt", CURRENT_TIMESTAMP)
WHERE "updatedAt" IS NULL;

ALTER TABLE "WebhookDelivery"
  ALTER COLUMN "updatedAt" SET NOT NULL;

CREATE INDEX "WebhookDelivery_status_nextAttemptAt_receivedAt_idx"
  ON "WebhookDelivery"("status", "nextAttemptAt", "receivedAt");

CREATE INDEX "WebhookDelivery_status_processingStartedAt_idx"
  ON "WebhookDelivery"("status", "processingStartedAt");
