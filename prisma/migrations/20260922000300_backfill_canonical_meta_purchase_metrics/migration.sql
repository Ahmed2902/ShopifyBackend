-- Historical Meta facts must be as complete as newly dual-written canonical facts before any
-- production read path can move to AdvertisingDailyMetric. The initial additive migration copied
-- common delivery metrics but intentionally left provider purchase semantics on MetaInsightAction.
-- Normalize those historical action rows now using the exact same priority as live Meta ingestion:
-- offsite pixel purchase -> omni_purchase -> purchase -> any other purchase action type.

WITH action_type_totals AS (
  SELECT
    action."insightId" AS insight_id,
    action."kind"::text AS kind,
    action."actionType" AS action_type,
    SUM(action."value") AS summed_value,
    MAX(action."value") FILTER (WHERE action."value" > 0) AS max_positive_value,
    CASE
      WHEN action."actionType" = 'offsite_conversion.fb_pixel_purchase' THEN 0
      WHEN action."actionType" = 'omni_purchase' THEN 1
      WHEN action."actionType" = 'purchase' THEN 2
      WHEN LOWER(action."actionType") LIKE '%purchase%' THEN 3
      ELSE 100
    END AS purchase_rank
  FROM "MetaInsightAction" action
  WHERE action."kind" IN ('ACTION', 'ACTION_VALUE', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS')
    AND (
      action."actionType" IN (
        'offsite_conversion.fb_pixel_purchase',
        'omni_purchase',
        'purchase'
      )
      OR LOWER(action."actionType") LIKE '%purchase%'
    )
  GROUP BY action."insightId", action."kind", action."actionType"
),
ranked_actions AS (
  SELECT
    totals.*,
    ROW_NUMBER() OVER (
      PARTITION BY totals.insight_id, totals.kind
      ORDER BY totals.purchase_rank ASC, totals.action_type ASC
    ) AS type_rank
  FROM action_type_totals totals
  WHERE totals.purchase_rank < 100
),
selected_actions AS (
  SELECT
    ranked.insight_id,
    MAX(ranked.summed_value) FILTER (
      WHERE ranked.kind = 'ACTION' AND ranked.type_rank = 1
    ) AS purchases,
    MAX(ranked.summed_value) FILTER (
      WHERE ranked.kind = 'ACTION_VALUE' AND ranked.type_rank = 1
    ) AS direct_purchase_value,
    MAX(ranked.max_positive_value) FILTER (
      WHERE ranked.kind = 'WEBSITE_PURCHASE_ROAS' AND ranked.type_rank = 1
    ) AS website_purchase_roas,
    MAX(ranked.max_positive_value) FILTER (
      WHERE ranked.kind = 'PURCHASE_ROAS' AND ranked.type_rank = 1
    ) AS purchase_roas
  FROM ranked_actions ranked
  GROUP BY ranked.insight_id
),
action_payloads AS (
  SELECT
    action."insightId" AS insight_id,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'ACTION' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS actions,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'UNIQUE_ACTION' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS unique_actions,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'ACTION_VALUE' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS action_values,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'COST_PER_ACTION' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS cost_per_action_type,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'COST_PER_UNIQUE_ACTION' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS cost_per_unique_action_type,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'CONVERSION' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS conversions,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'CONVERSION_VALUE' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS conversion_values,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'PURCHASE_ROAS' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS purchase_roas,
    COALESCE(
      jsonb_agg(action."metadata" ORDER BY action."id") FILTER (
        WHERE action."kind" = 'WEBSITE_PURCHASE_ROAS' AND action."metadata" IS NOT NULL
      ),
      '[]'::jsonb
    ) AS website_purchase_roas
  FROM "MetaInsightAction" action
  GROUP BY action."insightId"
),
normalized AS (
  SELECT
    insight."id" AS metric_id,
    COALESCE(selected.purchases, 0) AS purchases,
    CASE
      WHEN COALESCE(selected.direct_purchase_value, 0) > 0
        THEN selected.direct_purchase_value
      ELSE insight."spend" * COALESCE(
        selected.website_purchase_roas,
        selected.purchase_roas,
        0
      )
    END AS purchase_value,
    CASE
      WHEN COALESCE(selected.purchases, 0) > 0
        THEN insight."spend" / selected.purchases
      ELSE NULL
    END AS cpa,
    CASE
      WHEN insight."spend" > 0 THEN
        CASE
          WHEN COALESCE(selected.direct_purchase_value, 0) > 0
            THEN selected.direct_purchase_value / insight."spend"
          ELSE COALESCE(selected.website_purchase_roas, selected.purchase_roas, 0)
        END
      ELSE COALESCE(selected.website_purchase_roas, selected.purchase_roas)
    END AS roas,
    payload.actions,
    payload.unique_actions,
    payload.action_values,
    payload.cost_per_action_type,
    payload.cost_per_unique_action_type,
    payload.conversions AS conversion_actions,
    payload.conversion_values,
    payload.purchase_roas AS purchase_roas_actions,
    payload.website_purchase_roas AS website_purchase_roas_actions
  FROM "MetaInsightDaily" insight
  LEFT JOIN selected_actions selected ON selected.insight_id = insight."id"
  LEFT JOIN action_payloads payload ON payload.insight_id = insight."id"
)
UPDATE "AdvertisingDailyMetric" metric
SET
  "conversions" = normalized.purchases,
  "conversionValue" = normalized.purchase_value,
  "cpa" = normalized.cpa,
  "roas" = normalized.roas,
  "providerMetrics" = COALESCE(metric."providerMetrics", '{}'::jsonb) || jsonb_strip_nulls(
    jsonb_build_object(
      'actions', COALESCE(normalized.actions, '[]'::jsonb),
      'uniqueActions', COALESCE(normalized.unique_actions, '[]'::jsonb),
      'actionValues', COALESCE(normalized.action_values, '[]'::jsonb),
      'costPerActionType', COALESCE(normalized.cost_per_action_type, '[]'::jsonb),
      'costPerUniqueActionType', COALESCE(normalized.cost_per_unique_action_type, '[]'::jsonb),
      'conversions', COALESCE(normalized.conversion_actions, '[]'::jsonb),
      'conversionValues', COALESCE(normalized.conversion_values, '[]'::jsonb),
      'purchaseRoas', COALESCE(normalized.purchase_roas_actions, '[]'::jsonb),
      'websitePurchaseRoas', COALESCE(normalized.website_purchase_roas_actions, '[]'::jsonb)
    )
  ),
  "updatedAt" = CURRENT_TIMESTAMP
FROM normalized, "AdvertisingAccount" account
WHERE metric."id" = normalized.metric_id
  AND account."id" = metric."accountId"
  AND account."provider" = 'META'::"AdvertisingProvider";
