-- Preserve creative identity only when Stride has trustworthy observation provenance.
-- Existing rows intentionally remain untracked/NULL because joining them to the ad's current
-- creative would fabricate historical creative attribution after an ad creative changes.
ALTER TABLE "MetaInsightDaily"
ADD COLUMN "creativeIdSnapshot" UUID,
ADD COLUMN "creativeSnapshotTracked" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "MetaInsightDaily_creativeIdSnapshot_date_idx"
ON "MetaInsightDaily"("creativeIdSnapshot", "date");
