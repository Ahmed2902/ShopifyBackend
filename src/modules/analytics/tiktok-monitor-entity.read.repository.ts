import { prisma } from '../../lib/prisma.js';
import type {
  TikTokMonitorHierarchyItem,
  TikTokMonitorLevel,
} from './tiktok-monitor.read.repository.js';

/** Exact, store-scoped TikTok hierarchy reads for advisor drill-down. */
export class TikTokMonitorEntityReadRepository {
  async findHierarchyItem(input: {
    storeId: string;
    selectedAdvertiserIds: string[];
    level: TikTokMonitorLevel;
    entityId: string;
  }): Promise<Omit<TikTokMonitorHierarchyItem, 'metric'> | null> {
    if (input.selectedAdvertiserIds.length === 0) return null;
    const advertiser = {
      storeId: input.storeId,
      advertiserId: { in: input.selectedAdvertiserIds },
    } as const;

    if (input.level === 'campaigns') {
      const row = await prisma.tikTokCampaign.findFirst({
        where: { id: input.entityId, advertiser, deletedAt: null },
        select: {
          id: true,
          tiktokCampaignId: true,
          name: true,
          operationStatus: true,
          secondaryStatus: true,
          objectiveType: true,
        },
      });
      return row
        ? {
            id: row.id,
            externalId: row.tiktokCampaignId,
            name: row.name,
            status: row.operationStatus,
            secondaryStatus: row.secondaryStatus,
            parentName: null,
            objective: row.objectiveType,
            thumbnailUrl: null,
            targetScope: null,
          }
        : null;
    }

    if (input.level === 'groups') {
      const row = await prisma.tikTokAdGroup.findFirst({
        where: { id: input.entityId, advertiser, deletedAt: null },
        select: {
          id: true,
          tiktokAdGroupId: true,
          name: true,
          operationStatus: true,
          secondaryStatus: true,
          optimizationGoal: true,
          campaign: { select: { name: true } },
        },
      });
      return row
        ? {
            id: row.id,
            externalId: row.tiktokAdGroupId,
            name: row.name,
            status: row.operationStatus,
            secondaryStatus: row.secondaryStatus,
            parentName: row.campaign.name,
            objective: row.optimizationGoal,
            thumbnailUrl: null,
            targetScope: null,
          }
        : null;
    }

    const row = await prisma.tikTokAd.findFirst({
      where: { id: input.entityId, advertiser, deletedAt: null },
      select: {
        id: true,
        tiktokAdId: true,
        name: true,
        operationStatus: true,
        secondaryStatus: true,
        thumbnailUrl: true,
        targetScope: true,
        campaign: { select: { name: true } },
        adGroup: { select: { name: true } },
      },
    });
    return row
      ? {
          id: row.id,
          externalId: row.tiktokAdId,
          name: row.name,
          status: row.operationStatus,
          secondaryStatus: row.secondaryStatus,
          parentName: `${row.campaign.name} · ${row.adGroup.name}`,
          objective: null,
          thumbnailUrl: row.thumbnailUrl,
          targetScope: row.targetScope,
        }
      : null;
  }
}

export const tiktokMonitorEntityReadRepository = new TikTokMonitorEntityReadRepository();
