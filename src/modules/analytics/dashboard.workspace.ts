import { logger } from '../../lib/logger.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from '../intelligence/intelligence-snapshot.read.service.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { analyticsWorkspace, type AnalyticsWorkspace } from './analytics.workspace.js';
import { DashboardReadRepository, type DashboardRecentOrder } from './dashboard.read.repository.js';

type Section<T> =
  | { available: true; data: T }
  | { available: false; data: null };

function compactInventory(
  value: Awaited<ReturnType<AnalyticsWorkspace['inventory']>>,
) {
  return {
    inventoryMode: value.inventoryMode,
    items: value.items.map((row) => ({
      inventoryItemId: row.inventoryItemId,
      product: { id: row.product.id, title: row.product.title },
      variant: {
        id: row.variant.id,
        title: row.variant.title,
        displayName: row.variant.displayName,
      },
      available: row.available,
      incoming: row.incoming,
      unitsSoldInWindow: row.unitsSoldInWindow,
      unitsPerDay: row.unitsPerDay,
      daysCover: row.daysCover,
    })),
  };
}

function compactIntelligence(
  value: Awaited<ReturnType<IntelligenceSnapshotReadService['read']>>,
) {
  const recommendations = value.recommendations.slice(0, 4);
  return {
    evaluatedAt: value.evaluatedAt,
    recommendations,
    highPriorityCount: value.recommendations.filter(
      (item) => item.severity === 'CRITICAL' || item.severity === 'HIGH',
    ).length,
  };
}

async function optionalSection<T>(
  storeId: string,
  name: string,
  loader: () => Promise<T>,
): Promise<Section<T>> {
  try {
    return { available: true, data: await loader() };
  } catch (error) {
    logger.warn(
      { storeId, dashboardSection: name, error },
      'optional dashboard section failed',
    );
    return { available: false, data: null };
  }
}

/**
 * Browser-facing Overview composition.
 *
 * One request owns the complete dashboard interaction budget. The primary analytical overview is
 * required; secondary previews fail independently so an inventory/intelligence issue cannot hide
 * the merchant's core commerce KPIs. Secondary payloads are intentionally trimmed to fields the
 * Overview UI renders rather than forwarding full domain responses.
 */
export class DashboardWorkspace {
  constructor(
    private readonly analytics: AnalyticsWorkspace = analyticsWorkspace,
    private readonly intelligenceReads: IntelligenceSnapshotReadService =
      intelligenceSnapshotReadService,
    private readonly readRepository: DashboardReadRepository = new DashboardReadRepository(),
  ) {}

  async read(
    storeId: string,
    query: AnalyticsRangeQuery,
    now = new Date(),
    options: { fresh?: boolean } = {},
  ) {
    const inventoryQuery = {
      ...query,
      page: 1,
      limit: 8,
    };

    const [overview, inventory, intelligence, recentOrders] = await Promise.all([
      this.analytics.overview(storeId, query, now),
      optionalSection(storeId, 'inventory', async () =>
        compactInventory(await this.analytics.inventory(storeId, inventoryQuery, now)),
      ),
      optionalSection(storeId, 'intelligence', async () =>
        compactIntelligence(
          await this.intelligenceReads.read(storeId, { fresh: options.fresh ?? false }),
        ),
      ),
      optionalSection<DashboardRecentOrder[]>(storeId, 'recentOrders', () =>
        this.readRepository.getRecentOrders(storeId, 6),
      ),
    ]);

    return {
      overview,
      sections: {
        inventory,
        intelligence,
        recentOrders,
      },
    };
  }
}

export const dashboardWorkspace = new DashboardWorkspace();
