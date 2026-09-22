import {
  tiktokMonitorEntityReadRepository,
  type TikTokMonitorEntityReadRepository,
} from './tiktok-monitor-entity.read.repository.js';
import {
  TikTokMonitorReadRepository,
  type TikTokMonitorLevel,
} from './tiktok-monitor.read.repository.js';

function reportingWindow(days: number, now: Date) {
  const boundedDays = Math.min(Math.max(Math.trunc(days), 1), 90);
  const toDate = now.toISOString().slice(0, 10);
  const to = new Date(`${toDate}T00:00:00.000Z`);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (boundedDays - 1));
  return { days: boundedDays, from, to, fromDate: from.toISOString().slice(0, 10), toDate };
}

export class TikTokMonitorEntityReadService {
  constructor(
    private readonly repository = new TikTokMonitorReadRepository(),
    private readonly entities: TikTokMonitorEntityReadRepository = tiktokMonitorEntityReadRepository,
  ) {}

  async read(
    storeId: string,
    input: { days: number; level: TikTokMonitorLevel; entityId: string },
    now = new Date(),
  ) {
    const connection = await this.repository.getConnection(storeId);
    const selectedAdvertiserIds = connection?.selectedAdvertiserIds ?? [];
    const configured = connection?.status === 'ACTIVE' && selectedAdvertiserIds.length > 0;
    const window = reportingWindow(input.days, now);

    if (!configured) {
      return {
        connection: {
          status: connection?.status ?? 'DISCONNECTED',
          configured: false,
          selectedAdvertisers: selectedAdvertiserIds.length,
          lastSyncedAt: connection?.lastSyncedAt ?? null,
        },
        window: { days: window.days, from: window.fromDate, to: window.toDate },
        item: null,
      };
    }

    const item = await this.entities.findHierarchyItem({
      storeId,
      selectedAdvertiserIds,
      level: input.level,
      entityId: input.entityId,
    });
    const metrics = item
      ? await this.repository.getEntityMetrics({
          storeId,
          selectedAdvertiserIds,
          level: input.level,
          entityIds: [item.id],
          from: window.from,
          to: window.to,
        })
      : new Map();

    return {
      connection: {
        status: connection!.status,
        configured: true,
        selectedAdvertisers: selectedAdvertiserIds.length,
        lastSyncedAt: connection!.lastSyncedAt,
      },
      window: { days: window.days, from: window.fromDate, to: window.toDate },
      item: item ? { ...item, metric: metrics.get(item.id) ?? null } : null,
    };
  }
}

export const tiktokMonitorEntityReadService = new TikTokMonitorEntityReadService();
