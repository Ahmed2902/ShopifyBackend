import { TikTokMonitorReadRepository } from './tiktok-monitor.read.repository.js';
import type { TikTokMonitorQuery } from './tiktok-monitor.schema.js';

function reportingWindow(days: number, now: Date) {
  const toDate = now.toISOString().slice(0, 10);
  const to = new Date(`${toDate}T00:00:00.000Z`);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from, to, fromDate: from.toISOString().slice(0, 10), toDate };
}

export class TikTokMonitorService {
  constructor(private readonly repository = new TikTokMonitorReadRepository()) {}

  async read(storeId: string, query: TikTokMonitorQuery, now = new Date()) {
    const connection = await this.repository.getConnection(storeId);
    const selectedAdvertiserIds = connection?.selectedAdvertiserIds ?? [];
    const configured = connection?.status === 'ACTIVE' && selectedAdvertiserIds.length > 0;
    const window = reportingWindow(query.days, now);

    if (!configured) {
      return {
        connection: {
          status: connection?.status ?? 'DISCONNECTED',
          configured: false,
          selectedAdvertisers: selectedAdvertiserIds.length,
          lastSyncedAt: connection?.lastSyncedAt ?? null,
        },
        window: { days: query.days, from: window.fromDate, to: window.toDate },
        counts: { campaigns: 0, groups: 0, ads: 0 },
        summary: { currencies: [], rowCount: 0 },
        hierarchy: {
          level: query.level,
          page: query.page,
          limit: query.limit,
          total: 0,
          totalPages: 0,
          items: [],
        },
      };
    }

    const [counts, currencies, pageItems] = await Promise.all([
      this.repository.getCounts(storeId, selectedAdvertiserIds),
      this.repository.getSummary(storeId, selectedAdvertiserIds, window.from, window.to),
      this.repository.getHierarchyPage({
        storeId,
        selectedAdvertiserIds,
        level: query.level,
        page: query.page,
        limit: query.limit,
      }),
    ]);
    const metrics = await this.repository.getEntityMetrics({
      storeId,
      selectedAdvertiserIds,
      level: query.level,
      entityIds: pageItems.map((item) => item.id),
      from: window.from,
      to: window.to,
    });
    const total =
      query.level === 'campaigns' ? counts.campaigns : query.level === 'groups' ? counts.groups : counts.ads;

    return {
      connection: {
        status: connection.status,
        configured: true,
        selectedAdvertisers: selectedAdvertiserIds.length,
        lastSyncedAt: connection.lastSyncedAt,
      },
      window: { days: query.days, from: window.fromDate, to: window.toDate },
      counts,
      summary: {
        currencies,
        rowCount: currencies.reduce((sum, item) => sum + item.rowCount, 0),
      },
      hierarchy: {
        level: query.level,
        page: query.page,
        limit: query.limit,
        total,
        totalPages: total === 0 ? 0 : Math.ceil(total / query.limit),
        items: pageItems.map((item) => ({ ...item, metric: metrics.get(item.id) ?? null })),
      },
    };
  }
}

export const tiktokMonitorService = new TikTokMonitorService();
