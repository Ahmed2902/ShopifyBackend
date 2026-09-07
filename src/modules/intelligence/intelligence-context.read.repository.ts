import {
  ConnectionStatus,
  InventoryIntelligenceMode,
  Prisma,
  SyncStatus,
} from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

type RawIntelligenceContext = {
  id: string;
  currency_code: string;
  iana_timezone: string;
  inventory_mode: InventoryIntelligenceMode;
  inventory_reviewed_at: Date | null;
  shopify_status: ConnectionStatus | null;
  shopify_scopes: string[] | null;
  shopify_last_synced_at: Date | null;
  history_status: SyncStatus | null;
  history_records_read: number | null;
  history_records_written: number | null;
  history_finished_at: Date | null;
  meta_status: ConnectionStatus | null;
  selected_ad_account_ids: string[] | null;
  latest_meta_insight_synced_at: Date | null;
};

/**
 * Compact tenant/integration metadata required to plan one intelligence snapshot.
 *
 * One SQL round trip returns Store settings, provider connection state, latest successful Shopify
 * order-history readiness and latest selected-account Meta Insight freshness. This avoids ORM
 * relation fan-out and removes two standalone freshness queries from the snapshot critical path.
 */
export class IntelligenceContextReadRepository {
  async getContext(storeId: string) {
    const rows = await prisma.$queryRaw<RawIntelligenceContext[]>(Prisma.sql`
      SELECT
        store."id",
        store."currencyCode" AS currency_code,
        store."ianaTimezone" AS iana_timezone,
        store."inventoryIntelligenceMode" AS inventory_mode,
        store."inventoryReviewedAt" AS inventory_reviewed_at,
        shopify."status" AS shopify_status,
        shopify."scopes" AS shopify_scopes,
        shopify."lastSyncedAt" AS shopify_last_synced_at,
        history."status" AS history_status,
        history."recordsRead" AS history_records_read,
        history."recordsWritten" AS history_records_written,
        history."finishedAt" AS history_finished_at,
        meta."status" AS meta_status,
        meta."selectedAdAccountIds" AS selected_ad_account_ids,
        meta_freshness.latest_synced_at AS latest_meta_insight_synced_at
      FROM "Store" store
      LEFT JOIN "ShopifyConnection" shopify ON shopify."storeId" = store."id"
      LEFT JOIN LATERAL (
        SELECT
          sync."status",
          sync."recordsRead",
          sync."recordsWritten",
          sync."finishedAt"
        FROM "SyncRun" sync
        WHERE sync."shopifyConnectionId" = shopify."id"
          AND sync."provider" = 'SHOPIFY'
          AND sync."resourceType" = 'OrdersRefunds'
          AND sync."status" = 'SUCCEEDED'
        ORDER BY sync."createdAt" DESC
        LIMIT 1
      ) history ON TRUE
      LEFT JOIN "MetaConnection" meta ON meta."storeId" = store."id"
      LEFT JOIN LATERAL (
        SELECT MAX(insight."syncedAt") AS latest_synced_at
        FROM "MetaInsightDaily" insight
        INNER JOIN "MetaAdAccount" account ON account."id" = insight."adAccountId"
        WHERE insight."level" = 'AD'
          AND account."storeId" = store."id"
          AND meta."selectedAdAccountIds" IS NOT NULL
          AND account."metaAccountId" = ANY(meta."selectedAdAccountIds")
      ) meta_freshness ON TRUE
      WHERE store."id" = ${storeId}::uuid
      LIMIT 1
    `);

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      currencyCode: row.currency_code,
      ianaTimezone: row.iana_timezone,
      inventoryIntelligenceMode: row.inventory_mode,
      inventoryReviewedAt: row.inventory_reviewed_at,
      shopifyConnection:
        row.shopify_status === null
          ? null
          : {
              status: row.shopify_status,
              scopes: row.shopify_scopes ?? [],
              lastSyncedAt: row.shopify_last_synced_at,
            },
      metaConnection:
        row.meta_status === null
          ? null
          : {
              status: row.meta_status,
              selectedAdAccountIds: row.selected_ad_account_ids ?? [],
            },
      successfulOrderHistorySync:
        row.history_status === null
          ? null
          : {
              status: row.history_status,
              recordsRead: row.history_records_read ?? 0,
              recordsWritten: row.history_records_written ?? 0,
              finishedAt: row.history_finished_at,
            },
      latestMetaInsightSyncedAt: row.latest_meta_insight_synced_at,
    };
  }
}

export const intelligenceContextReadRepository = new IntelligenceContextReadRepository();
