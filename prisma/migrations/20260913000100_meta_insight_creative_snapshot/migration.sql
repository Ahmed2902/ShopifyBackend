-- Preserve the creative identity observed when a Meta daily insight row is first recorded.
-- Existing rows intentionally remain NULL because joining them to the ad's current creative
-- would fabricate historical creative attribution after an ad creative changes.
ALTER TABLE "MetaInsightDaily"
ADD COLUMN "creativeIdSnapshot" UUID;

CREATE INDEX "MetaInsightDaily_creativeIdSnapshot_date_idx"
ON "MetaInsightDaily"("creativeIdSnapshot", "date");
