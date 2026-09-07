-- The original privacy migration created database-side UUID defaults, while the Prisma models
-- intentionally use Prisma's client-side `uuid()` defaults. Remove the database defaults so the
-- applied schema and Prisma schema remain drift-free without rewriting already-merged history.
ALTER TABLE "ShopifyDataRequest"
  ALTER COLUMN "id" DROP DEFAULT;

ALTER TABLE "ShopifyOrderRedaction"
  ALTER COLUMN "id" DROP DEFAULT;
