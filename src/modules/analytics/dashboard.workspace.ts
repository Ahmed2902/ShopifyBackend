import { logger } from '../../lib/logger.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from '../intelligence/intelligence-snapshot.read.service.js';
import {
  pixelAttributionService,
  type PixelAttributionService,
} from '../pixel/attribution/pixel-attribution.service.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { analyticsWorkspace, type AnalyticsWorkspace } from './analytics.workspace.js';
import {
  DashboardReadRepository,
  type DashboardInventoryPreview,
  type DashboardRecentOrder,
} from './dashboard.read.repository.js';
import {
  performanceAnalyticsWorkspace,
  type PerformanceAnalyticsWorkspace,
} from './performance-analytics.workspace.js';

type Section<T> =
  | { available: true; data: T }
  | { available: false; data: null };

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
 * required; secondary previews and chart-ready read models fail independently so a secondary
 * analytical issue cannot hide the merchant's core commerce KPIs. Customer segmentation,
 * top-product economics and first-party acquisition-source evidence are composed here as well,
 * keeping Home dense without adding browser request waterfalls. The complete response participates
 * in the Store-generation dashboard cache.
 */
export class DashboardWorkspace {
  constructor(
    private readonly analytics: AnalyticsWorkspace = analyticsWorkspace,
    private readonly intelligenceReads: IntelligenceSnapshotReadService =
      intelligenceSnapshotReadService,
    private readonly readRepository: DashboardReadRepository = new DashboardReadRepository(),
    private readonly performance: PerformanceAnalyticsWorkspace = performanceAnalyticsWorkspace,
    private readonly attribution: PixelAttributionService = pixelAttributionService,
  ) {}

  async read(
    storeId: string,
    query: AnalyticsRangeQuery,
    now = new Date(),
    options: { fresh?: boolean } = {},
  ) {
    const [
      overview,
      inventory,
      intelligence,
      recentOrders,
      performance,
      customers,
      topProducts,
      acquisitionSources,
    ] = await Promise.all([
      this.analytics.overview(storeId, query, now),
      optionalSection<DashboardInventoryPreview>(storeId, 'inventory', () =>
        this.readRepository.getInventoryPreview({
          storeId,
          days: query.days,
          from: query.from,
          to: query.to,
          now,
          limit: 8,
        }),
      ),
      optionalSection(storeId, 'intelligence', async () =>
        compactIntelligence(
          await this.intelligenceReads.read(storeId, { fresh: options.fresh ?? false }),
        ),
      ),
      optionalSection<DashboardRecentOrder[]>(storeId, 'recentOrders', () =>
        this.readRepository.getRecentOrders(storeId, 6),
      ),
      optionalSection(storeId, 'performance', () => this.performance.daily(storeId, query, now)),
      optionalSection(storeId, 'customers', () => this.analytics.customers(storeId, query, now)),
      optionalSection(storeId, 'topProducts', async () => {
        const result = await this.analytics.products(
          storeId,
          { ...query, page: 1, limit: 6 },
          now,
        );
        return result.items.map((row) => ({
          product: { id: row.product.id, title: row.product.title },
          orderCount: row.current.orderCount,
          netUnits: row.current.netUnits,
          netRevenue: row.current.netProductRevenue,
        }));
      }),
      optionalSection(storeId, 'acquisitionSources', () =>
        this.attribution.sources(
          storeId,
          {
            ...query,
            page: 1,
            limit: 8,
          },
          now,
        ),
      ),
    ]);

    return {
      overview,
      sections: {
        inventory,
        intelligence,
        recentOrders,
        performance,
        customers,
        topProducts,
        acquisitionSources,
      },
    };
  }
}

export const dashboardWorkspace = new DashboardWorkspace();
