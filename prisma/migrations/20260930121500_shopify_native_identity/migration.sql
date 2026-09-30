CREATE TABLE "ShopifyUserIdentity" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "shopifyUserId" TEXT NOT NULL,
    "email" TEXT,
    "name" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "collaborator" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "lastAuthenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopifyUserIdentity_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifyUserIdentity_storeId_shopifyUserId_key"
    ON "ShopifyUserIdentity"("storeId", "shopifyUserId");
CREATE INDEX "ShopifyUserIdentity_userId_idx" ON "ShopifyUserIdentity"("userId");
CREATE INDEX "ShopifyUserIdentity_storeId_lastAuthenticatedAt_idx"
    ON "ShopifyUserIdentity"("storeId", "lastAuthenticatedAt");

ALTER TABLE "ShopifyUserIdentity"
    ADD CONSTRAINT "ShopifyUserIdentity_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ShopifyUserIdentity"
    ADD CONSTRAINT "ShopifyUserIdentity_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
