CREATE TYPE "RecommendationLifecycleState" AS ENUM ('OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED');

CREATE TABLE "RecommendationLifecycle" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "occurrenceKey" VARCHAR(512) NOT NULL,
  "state" "RecommendationLifecycleState" NOT NULL DEFAULT 'OPEN',
  "reviewedAt" TIMESTAMP(3),
  "dismissedAt" TIMESTAMP(3),
  "resolvedAt" TIMESTAMP(3),
  "reopenedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "RecommendationLifecycle_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecommendationLifecycle_storeId_occurrenceKey_key"
  ON "RecommendationLifecycle"("storeId", "occurrenceKey");

CREATE INDEX "RecommendationLifecycle_storeId_state_updatedAt_idx"
  ON "RecommendationLifecycle"("storeId", "state", "updatedAt");

ALTER TABLE "RecommendationLifecycle"
  ADD CONSTRAINT "RecommendationLifecycle_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
