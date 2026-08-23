-- Keep the deployed TikTok connection schema aligned with Prisma's required array fields.
-- This is intentionally a follow-up migration so databases that already applied the
-- original TikTok foundation migration are repaired safely.

UPDATE "TikTokConnection"
SET "selectedAdvertiserIds" = ARRAY[]::TEXT[]
WHERE "selectedAdvertiserIds" IS NULL;

UPDATE "TikTokConnection"
SET "selectedCatalogIds" = ARRAY[]::TEXT[]
WHERE "selectedCatalogIds" IS NULL;

UPDATE "TikTokConnection"
SET "scopes" = ARRAY[]::TEXT[]
WHERE "scopes" IS NULL;

ALTER TABLE "TikTokConnection"
  ALTER COLUMN "selectedAdvertiserIds" SET NOT NULL,
  ALTER COLUMN "selectedCatalogIds" SET NOT NULL,
  ALTER COLUMN "scopes" SET NOT NULL;
