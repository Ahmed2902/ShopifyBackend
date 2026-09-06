CREATE TYPE "PixelInstallationStatus" AS ENUM (
  'ACTIVE',
  'ERROR',
  'DISABLED'
);

CREATE TABLE "PixelInstallation" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "collectorTokenHash" VARCHAR(64) NOT NULL,
  "collectorTokenPrefix" VARCHAR(12) NOT NULL,
  "shopifyWebPixelId" VARCHAR(128),
  "status" "PixelInstallationStatus" NOT NULL DEFAULT 'ERROR',
  "installedAt" TIMESTAMP(3),
  "lastEventAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PixelInstallation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "PixelInstallation_storeId_key"
  ON "PixelInstallation"("storeId");

CREATE UNIQUE INDEX "PixelInstallation_shopifyWebPixelId_key"
  ON "PixelInstallation"("shopifyWebPixelId");

CREATE INDEX "PixelInstallation_status_idx"
  ON "PixelInstallation"("status");

CREATE INDEX "PixelInstallation_lastEventAt_idx"
  ON "PixelInstallation"("lastEventAt");

ALTER TABLE "PixelInstallation"
  ADD CONSTRAINT "PixelInstallation_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
