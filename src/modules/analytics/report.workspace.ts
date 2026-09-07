import { logger } from '../../lib/logger.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from '../intelligence/intelligence-snapshot.read.service.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { analyticsWorkspace, type AnalyticsWorkspace } from './analytics.workspace.js';

type OptionalSection<T> =
  | { available: true; data: T }
  | { available: false; data: null };

async function optionalSection<T>(
  storeId: string,
  name: string,
  loader: () => Promise<T>,
): Promise<OptionalSection<T>> {
  try {
    return { available: true, data: await loader() };
  } catch (error) {
    logger.warn({ storeId, reportSection: name, error }, 'optional report section failed');
    return { available: false, data: null };
  }
}

/**
 * Browser-facing historical report composition.
 *
 * The commerce/advertising overview is required. Intelligence is useful context but remains an
 * optional section so a rule-engine failure cannot hide otherwise valid historical analytics.
 * The intelligence read uses the shared snapshot coordinator, so a warm Overview/Intelligence
 * navigation reuses the same cached/in-flight evidence computation.
 */
export class ReportWorkspace {
  constructor(
    private readonly analytics: AnalyticsWorkspace = analyticsWorkspace,
    private readonly intelligenceReads: IntelligenceSnapshotReadService =
      intelligenceSnapshotReadService,
  ) {}

  async read(
    storeId: string,
    query: AnalyticsRangeQuery,
    now = new Date(),
    options: { fresh?: boolean } = {},
  ) {
    const [overview, intelligence] = await Promise.all([
      this.analytics.overview(storeId, query, now),
      optionalSection(storeId, 'intelligence', () =>
        this.intelligenceReads.read(storeId, { fresh: options.fresh ?? false }),
      ),
    ]);

    return {
      overview,
      sections: { intelligence },
    };
  }
}

export const reportWorkspace = new ReportWorkspace();
