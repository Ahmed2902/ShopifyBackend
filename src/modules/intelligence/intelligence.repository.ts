import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type {
  DataQualityEvidence,
  RecommendationCategory,
  RecommendationDraft,
  RecommendationEntityType,
  RecommendationSeverity,
  RecommendationStatus,
} from './intelligence.types.js';

function json(value: Record<string, unknown>): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function dedupeKey(draft: RecommendationDraft): string {
  return [draft.ruleId, draft.entityType, draft.entityId ?? draft.externalEntityId ?? 'store'].join(':');
}

export class IntelligenceRepository {
  getStoreContext(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        currencyCode: true,
        ianaTimezone: true,
        intelligenceSettings: {
          select: {
            inventoryMode: true,
            targetRoas: true,
            targetCpa: true,
            inventoryReviewedAt: true,
          },
        },
        shopifyConnection: {
          select: { status: true, scopes: true, lastSyncedAt: true },
        },
        metaConnection: {
          select: {
            status: true,
            scopes: true,
            selectedAdAccountIds: true,
            selectedCatalogIds: true,
            lastSyncedAt: true,
          },
        },
      },
    });
  }

  async getMetaEvidenceRows(storeId: string, from: Date, to: Date) {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    const selectedIds = connection?.selectedAdAccountIds ?? [];
    if (selectedIds.length === 0) return [];

    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from, lte: to },
        adAccount: { storeId, metaAccountId: { in: selectedIds } },
      },
      select: {
        date: true,
        accountCurrency: true,
        spend: true,
        impressions: true,
        reach: true,
        clicks: true,
        frequency: true,
        campaign: {
          select: {
            id: true,
            metaCampaignId: true,
            name: true,
            effectiveStatus: true,
            objective: true,
          },
        },
        ad: {
          select: {
            id: true,
            metaAdId: true,
            name: true,
            creative: {
              select: { id: true, metaCreativeId: true, name: true, title: true },
            },
          },
        },
        actions: {
          where: { kind: { in: ['ACTION', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS'] } },
          select: { kind: true, actionType: true, actionDestination: true, value: true },
        },
      },
      orderBy: [{ date: 'asc' }, { adId: 'asc' }],
    });
  }

  getCommerceRows(storeId: string, from: Date, to: Date) {
    return prisma.orderLineItem.findMany({
      where: {
        order: {
          storeId,
          isTest: false,
          cancelledAt: null,
          shopifyCreatedAt: { gte: from, lte: to },
        },
        productId: { not: null },
      },
      select: {
        productId: true,
        variantId: true,
        quantity: true,
        currentQuantity: true,
        discountedTotal: true,
        order: {
          select: { shopifyCreatedAt: true, currencyCode: true },
        },
        product: {
          select: { id: true, shopifyProductId: true, title: true },
        },
        refundLines: {
          select: { quantity: true, subtotal: true },
        },
      },
    });
  }

  getVariantCosts(storeId: string, variantIds: string[], from: Date, to: Date) {
    if (variantIds.length === 0) return Promise.resolve([]);
    return prisma.variantCost.findMany({
      where: {
        variantId: { in: variantIds },
        variant: { storeId },
        effectiveFrom: { lte: to },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: from } }],
      },
      select: {
        variantId: true,
        amount: true,
        currency: true,
        source: true,
        effectiveFrom: true,
        effectiveUntil: true,
      },
      orderBy: [{ variantId: 'asc' }, { effectiveFrom: 'asc' }],
    });
  }

  getActiveProductMappings(storeId: string) {
    return prisma.adProductMapping.findMany({
      where: {
        validUntil: null,
        ad: { adAccount: { storeId }, deletedAt: null },
        product: { storeId, deletedAt: null },
      },
      select: {
        metaAdId: true,
        productId: true,
        variantId: true,
        confidence: true,
        source: true,
        isMerchantConfirmed: true,
      },
    });
  }

  getInventoryLevels(storeId: string) {
    return prisma.inventoryLevelCurrent.findMany({
      where: {
        inventoryItem: {
          storeId,
          deletedAt: null,
          variant: { deletedAt: null, product: { deletedAt: null } },
        },
        location: { deletedAt: null, isActive: true },
      },
      select: {
        available: true,
        onHand: true,
        incoming: true,
        inventoryItem: {
          select: {
            variant: {
              select: {
                id: true,
                productId: true,
              },
            },
          },
        },
      },
    });
  }

  async getFreshness(storeId: string) {
    const [latestOrder, latestInsight, latestShopifyRun, latestMetaRun] = await Promise.all([
      prisma.order.findFirst({
        where: { storeId, isTest: false },
        orderBy: { shopifyCreatedAt: 'desc' },
        select: { shopifyCreatedAt: true },
      }),
      prisma.metaInsightDaily.findFirst({
        where: { adAccount: { storeId } },
        orderBy: { date: 'desc' },
        select: { date: true, syncedAt: true },
      }),
      prisma.syncRun.findFirst({
        where: { provider: 'SHOPIFY', shopifyConnection: { storeId }, status: 'SUCCEEDED' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, resourceType: true },
      }),
      prisma.syncRun.findFirst({
        where: { provider: 'META', metaConnection: { storeId }, status: 'SUCCEEDED' },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true, resourceType: true },
      }),
    ]);
    return { latestOrder, latestInsight, latestShopifyRun, latestMetaRun };
  }

  async syncRecommendations(storeId: string, drafts: RecommendationDraft[]) {
    const existing = await prisma.recommendation.findMany({
      where: { storeId },
      select: { id: true, dedupeKey: true, status: true },
    });
    const byKey = new Map(existing.map((item) => [item.dedupeKey, item]));
    const emitted = new Set(drafts.map(dedupeKey));
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      let created = 0;
      let updated = 0;
      let resolved = 0;

      for (const draft of drafts) {
        const key = dedupeKey(draft);
        const current = byKey.get(key);
        const priority = draft.impactScore * draft.confidenceScore * draft.urgencyScore;
        const data = {
          ruleId: draft.ruleId,
          ruleVersion: draft.ruleVersion,
          category: draft.category,
          severity: draft.severity,
          entityType: draft.entityType,
          entityId: draft.entityId,
          externalEntityId: draft.externalEntityId,
          title: draft.title,
          summary: draft.summary,
          suggestedAction: draft.suggestedAction,
          priority,
          impactScore: draft.impactScore,
          confidenceScore: draft.confidenceScore,
          urgencyScore: draft.urgencyScore,
          observationStart: draft.observationStart,
          observationEnd: draft.observationEnd,
          comparisonStart: draft.comparisonStart,
          comparisonEnd: draft.comparisonEnd,
          evidenceJson: json(draft.evidence),
          blockersJson: draft.blockers ? json(draft.blockers) : Prisma.DbNull,
          generatedAt: now,
          validUntil: null,
        };

        if (!current) {
          const saved = await tx.recommendation.create({
            data: { storeId, dedupeKey: key, ...data },
            select: { id: true },
          });
          await tx.recommendationEvent.create({
            data: { recommendationId: saved.id, status: 'CREATED' },
          });
          created += 1;
          continue;
        }

        const reopen = current.status === 'RESOLVED';
        await tx.recommendation.update({
          where: { id: current.id },
          data: {
            ...data,
            ...(reopen ? { status: 'CREATED', resolvedAt: null } : {}),
          },
        });
        if (reopen) {
          await tx.recommendationEvent.create({
            data: {
              recommendationId: current.id,
              status: 'CREATED',
              metadataJson: { reason: 'signal_returned' },
            },
          });
        }
        updated += 1;
      }

      for (const current of existing) {
        if (emitted.has(current.dedupeKey) || current.status === 'RESOLVED') continue;
        await tx.recommendation.update({
          where: { id: current.id },
          data: { status: 'RESOLVED', resolvedAt: now },
        });
        await tx.recommendationEvent.create({
          data: {
            recommendationId: current.id,
            status: 'RESOLVED',
            metadataJson: { reason: 'signal_cleared' },
          },
        });
        resolved += 1;
      }

      return { created, updated, resolved, active: drafts.length };
    });
  }

  async listRecommendations(
    storeId: string,
    input: {
      status?: RecommendationStatus;
      category?: RecommendationCategory;
      severity?: RecommendationSeverity;
      entityType?: RecommendationEntityType;
      page: number;
      limit: number;
    },
  ) {
    const where = {
      storeId,
      ...(input.status ? { status: input.status } : {}),
      ...(input.category ? { category: input.category } : {}),
      ...(input.severity ? { severity: input.severity } : {}),
      ...(input.entityType ? { entityType: input.entityType } : {}),
    } satisfies Prisma.RecommendationWhereInput;
    const [items, total] = await Promise.all([
      prisma.recommendation.findMany({
        where,
        select: {
          id: true,
          ruleId: true,
          ruleVersion: true,
          category: true,
          severity: true,
          status: true,
          entityType: true,
          entityId: true,
          externalEntityId: true,
          title: true,
          summary: true,
          suggestedAction: true,
          priority: true,
          impactScore: true,
          confidenceScore: true,
          urgencyScore: true,
          observationStart: true,
          observationEnd: true,
          comparisonStart: true,
          comparisonEnd: true,
          evidenceJson: true,
          blockersJson: true,
          generatedAt: true,
          resolvedAt: true,
        },
        orderBy: [{ priority: 'desc' }, { generatedAt: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.recommendation.count({ where }),
    ]);
    return { items, total };
  }

  getRecommendation(storeId: string, id: string) {
    return prisma.recommendation.findFirst({
      where: { id, storeId },
      include: {
        events: { orderBy: { occurredAt: 'desc' }, take: 50 },
        outcomes: { orderBy: { horizonDays: 'asc' } },
      },
    });
  }

  async setRecommendationStatus(
    storeId: string,
    id: string,
    status: RecommendationStatus,
    actorUserId: string,
  ) {
    const current = await prisma.recommendation.findFirst({
      where: { id, storeId },
      select: { id: true, status: true },
    });
    if (!current) return null;
    if (current.status === status) return current;

    return prisma.$transaction(async (tx) => {
      const updated = await tx.recommendation.update({
        where: { id },
        data: {
          status,
          resolvedAt: status === 'RESOLVED' ? new Date() : null,
        },
        select: { id: true, status: true },
      });
      await tx.recommendationEvent.create({
        data: { recommendationId: id, status, actorUserId },
      });
      return updated;
    });
  }

  async recordDataQualitySnapshots(storeId: string, evidence: DataQualityEvidence[]) {
    if (evidence.length === 0) return 0;
    await prisma.dataQualitySnapshot.createMany({
      data: evidence.map((item) => ({
        storeId,
        provider: item.surface.startsWith('SHOPIFY')
          ? 'SHOPIFY'
          : item.surface.startsWith('META')
            ? 'META'
            : null,
        surface: item.surface,
        status: item.status,
        code: item.code,
        metricsJson: item.metrics ? json(item.metrics) : Prisma.DbNull,
        message: item.message,
      })),
    });
    return evidence.length;
  }

  listRecentDataQuality(storeId: string, limit = 100) {
    return prisma.dataQualitySnapshot.findMany({
      where: { storeId },
      select: {
        surface: true,
        status: true,
        code: true,
        metricsJson: true,
        message: true,
        observedAt: true,
      },
      orderBy: { observedAt: 'desc' },
      take: limit,
    });
  }

  getOrCreateSettings(storeId: string) {
    return prisma.storeIntelligenceSettings.upsert({
      where: { storeId },
      create: { storeId },
      update: {},
      select: {
        inventoryMode: true,
        targetRoas: true,
        targetCpa: true,
        inventoryReviewedAt: true,
      },
    });
  }

  updateInventoryMode(storeId: string, inventoryMode: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE') {
    return prisma.storeIntelligenceSettings.upsert({
      where: { storeId },
      create: { storeId, inventoryMode, inventoryReviewedAt: new Date() },
      update: { inventoryMode, inventoryReviewedAt: new Date() },
      select: {
        inventoryMode: true,
        targetRoas: true,
        targetCpa: true,
        inventoryReviewedAt: true,
      },
    });
  }
}
