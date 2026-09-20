-- These tables are written continuously by provider/order ingestion. Build the analytical indexes
-- without blocking inserts/updates/deletes on an established production database.
-- Prisma ORM v7 cannot express CONCURRENTLY in @@index, so the schema declares the index shape and
-- this reviewed migration supplies the PostgreSQL deployment option.
CREATE INDEX CONCURRENTLY "MetaInsightDaily_adAccountId_level_date_idx"
ON "MetaInsightDaily"("adAccountId", "level", "date");

CREATE INDEX CONCURRENTLY "OrderLineItem_productId_orderId_idx"
ON "OrderLineItem"("productId", "orderId");
