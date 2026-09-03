import { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

export type MetaStateEntityType = 'CAMPAIGN' | 'AD_SET' | 'AD';

export interface MetaStateCandidate {
  entityType: MetaStateEntityType;
  localEntityId: string;
  externalEntityId: string;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  objective: string | null;
  optimizationGoal: string | null;
  bidStrategy: string | null;
  dailyBudgetMinor: bigint | null;
  lifetimeBudgetMinor: bigint | null;
  budgetRemainingMinor: bigint | null;
  spendCapMinor: bigint | null;
}

function signature(candidate: Omit<MetaStateCandidate, 'localEntityId'>): string {
  return JSON.stringify({
    configuredStatus: candidate.configuredStatus,
    effectiveStatus: candidate.effectiveStatus,
    objective: candidate.objective,
    optimizationGoal: candidate.optimizationGoal,
    bidStrategy: candidate.bidStrategy,
    dailyBudgetMinor: candidate.dailyBudgetMinor?.toString() ?? null,
    lifetimeBudgetMinor: candidate.lifetimeBudgetMinor?.toString() ?? null,
    budgetRemainingMinor: candidate.budgetRemainingMinor?.toString() ?? null,
    spendCapMinor: candidate.spendCapMinor?.toString() ?? null,
  });
}

function key(entityType: MetaStateEntityType, externalEntityId: string): string {
  return `${entityType}:${externalEntityId}`;
}

export class MetaStateRepository {
  async loadBaseline(adAccountId: string): Promise<Map<string, string>> {
    const [campaigns, adSets, ads] = await Promise.all([
      prisma.metaCampaign.findMany({
        where: { adAccountId, deletedAt: null },
        select: {
          metaCampaignId: true,
          configuredStatus: true,
          effectiveStatus: true,
          objective: true,
          bidStrategy: true,
          dailyBudgetMinor: true,
          lifetimeBudgetMinor: true,
          budgetRemainingMinor: true,
          spendCapMinor: true,
        },
      }),
      prisma.metaAdSet.findMany({
        where: { adAccountId, deletedAt: null },
        select: {
          metaAdSetId: true,
          configuredStatus: true,
          effectiveStatus: true,
          optimizationGoal: true,
          bidStrategy: true,
          dailyBudgetMinor: true,
          lifetimeBudgetMinor: true,
          budgetRemainingMinor: true,
          lifetimeSpendCapMinor: true,
        },
      }),
      prisma.metaAd.findMany({
        where: { adAccountId, deletedAt: null },
        select: { metaAdId: true, configuredStatus: true, effectiveStatus: true },
      }),
    ]);

    const baseline = new Map<string, string>();
    for (const campaign of campaigns) {
      baseline.set(
        key('CAMPAIGN', campaign.metaCampaignId),
        signature({
          entityType: 'CAMPAIGN',
          externalEntityId: campaign.metaCampaignId,
          configuredStatus: campaign.configuredStatus,
          effectiveStatus: campaign.effectiveStatus,
          objective: campaign.objective,
          optimizationGoal: null,
          bidStrategy: campaign.bidStrategy,
          dailyBudgetMinor: campaign.dailyBudgetMinor,
          lifetimeBudgetMinor: campaign.lifetimeBudgetMinor,
          budgetRemainingMinor: campaign.budgetRemainingMinor,
          spendCapMinor: campaign.spendCapMinor,
        }),
      );
    }
    for (const adSet of adSets) {
      baseline.set(
        key('AD_SET', adSet.metaAdSetId),
        signature({
          entityType: 'AD_SET',
          externalEntityId: adSet.metaAdSetId,
          configuredStatus: adSet.configuredStatus,
          effectiveStatus: adSet.effectiveStatus,
          objective: null,
          optimizationGoal: adSet.optimizationGoal,
          bidStrategy: adSet.bidStrategy,
          dailyBudgetMinor: adSet.dailyBudgetMinor,
          lifetimeBudgetMinor: adSet.lifetimeBudgetMinor,
          budgetRemainingMinor: adSet.budgetRemainingMinor,
          spendCapMinor: adSet.lifetimeSpendCapMinor,
        }),
      );
    }
    for (const ad of ads) {
      baseline.set(
        key('AD', ad.metaAdId),
        signature({
          entityType: 'AD',
          externalEntityId: ad.metaAdId,
          configuredStatus: ad.configuredStatus,
          effectiveStatus: ad.effectiveStatus,
          objective: null,
          optimizationGoal: null,
          bidStrategy: null,
          dailyBudgetMinor: null,
          lifetimeBudgetMinor: null,
          budgetRemainingMinor: null,
          spendCapMinor: null,
        }),
      );
    }
    return baseline;
  }

  async recordChanges(
    storeId: string,
    adAccountId: string,
    baseline: Map<string, string>,
    candidates: MetaStateCandidate[],
  ): Promise<number> {
    const changed = candidates.filter((candidate) => {
      const previous = baseline.get(key(candidate.entityType, candidate.externalEntityId));
      return previous !== signature(candidate);
    });
    if (changed.length === 0) return 0;

    const observedAt = new Date();
    await prisma.metaEntityStateSnapshot.createMany({
      data: changed.map((candidate) => ({
        storeId,
        adAccountId,
        entityType: candidate.entityType,
        localEntityId: candidate.localEntityId,
        externalEntityId: candidate.externalEntityId,
        observedAt,
        configuredStatus: candidate.configuredStatus,
        effectiveStatus: candidate.effectiveStatus,
        objective: candidate.objective,
        optimizationGoal: candidate.optimizationGoal,
        bidStrategy: candidate.bidStrategy,
        dailyBudgetMinor: candidate.dailyBudgetMinor,
        lifetimeBudgetMinor: candidate.lifetimeBudgetMinor,
        budgetRemainingMinor: candidate.budgetRemainingMinor,
        spendCapMinor: candidate.spendCapMinor,
        stateJson: {
          configuredStatus: candidate.configuredStatus,
          effectiveStatus: candidate.effectiveStatus,
          objective: candidate.objective,
          optimizationGoal: candidate.optimizationGoal,
          bidStrategy: candidate.bidStrategy,
          dailyBudgetMinor: candidate.dailyBudgetMinor?.toString() ?? null,
          lifetimeBudgetMinor: candidate.lifetimeBudgetMinor?.toString() ?? null,
          budgetRemainingMinor: candidate.budgetRemainingMinor?.toString() ?? null,
          spendCapMinor: candidate.spendCapMinor?.toString() ?? null,
        } satisfies Prisma.InputJsonValue,
      })),
    });
    return changed.length;
  }
}
