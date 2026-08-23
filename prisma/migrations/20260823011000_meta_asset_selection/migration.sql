-- Persist the merchant-selected Meta assets independently of discovered provider data.
ALTER TABLE "MetaConnection"
ADD COLUMN "selectedAdAccountIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "selectedCatalogIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
