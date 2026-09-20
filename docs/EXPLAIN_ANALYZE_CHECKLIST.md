# Analytics query-plan verification

Index changes in this PR are deliberately narrow. Do not remove an existing index solely from schema inspection: validate the real plan against production-like row counts first.

For any endpoint that still breaches its source-path performance budget after the performance PRs are combined:

1. Capture the slowest SQL shape from request/background performance telemetry.
2. Run the equivalent statement on a production-like database with:

```sql
EXPLAIN (ANALYZE, BUFFERS, VERBOSE, SETTINGS)
<statement>;
```

3. Check for:
   - sequential scans across large `MetaInsightDaily`, `MetaInsightAction`, `Order`, or `OrderLineItem` ranges;
   - large rows-removed-by-filter counts;
   - sort/hash spills to disk;
   - repeated nested-loop scans whose inner side grows with result size;
   - an index whose range column appears before a selective equality predicate;
   - materially unused near-duplicate indexes before removing either one.
4. Re-run the exact query and the endpoint benchmark after any index change.
5. Keep an index only when the measured read benefit justifies its write/storage cost.

## Current candidates

- `MetaInsightDaily(adAccountId, level, date)` targets the common account + `level = 'AD'` + date-range shape.
- `OrderLineItem(productId, orderId)` targets product-economics reads that constrain product identity before joining orders.

The older `MetaInsightDaily(adAccountId, date, level)` index remains intentionally until an EXPLAIN comparison on realistic data proves it redundant. This avoids turning a performance PR into a speculative index removal.
