-- Meta analytical reads constrain account + insight level before scanning a date range.
CREATE INDEX "MetaInsightDaily_adAccountId_level_date_idx"
ON "MetaInsightDaily"("adAccountId", "level", "date");

-- Product economics/leaderboard reads constrain product identity before joining back to orders.
CREATE INDEX "OrderLineItem_productId_orderId_idx"
ON "OrderLineItem"("productId", "orderId");
