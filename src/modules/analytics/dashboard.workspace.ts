import { logger } from '../../lib/logger.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from '../intelligence/intelligence-snapshot.read.service.js';
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
 * required; secondary previews and the chart-ready performance series fail independently so a
 * secondary analytical issue cannot hide the merchant's core commerce KPIs. The complete response
 * participates in the Store-generation dashboard cache, avoiding a second browser request solely
 * for the trend chart.
 */
export class DashboardWorkspace {
  constructor(
    private readonly analytics: AnalyticsWorkspace = analyticsWorkspace,
    private readonly intelligenceReads: IntelligenceSnapshotReadService =
      intelligenceSnapshotReadService,
    private readonly readRepository: DashboardReadRepository = new DashboardReadRepository(),
    private readonly performance: PerformanceAnalyticsWorkspace = performanceAnalyticsWorkspace,
  ) {}

  async read(
    storeId: string,
    query: AnalyticsRangeQuery,
    now = new Date(),
    options: { fresh?: boolean } = {},
  ) {
    const [overview, inventory, intelligence, recentOrders, performance] = await Promise.all([
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
    ]);

    return {
      overview,
      sections: {
        inventory,
        intelligence,
        recentOrders,
        performance,
      },
    };
  }
}

export const dashboardWorkspace = new DashboardWorkspace();
