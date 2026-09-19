import { prisma } from '../../lib/prisma.js';
import { IntelligenceCommerceReadRepository } from './intelligence-commerce.read.repository.js';
import type { RecommendationDraft } from './intelligence.types.js';

type RankedRecommendation = RecommendationDraft & { priority: number };

const WINDOW_DAYS = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export class MerchantInventoryRiskService {
  constructor(
    private readonly commerce = new IntelligenceCommerceReadRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async recommendations(storeId: string): Promise<RankedRecommendation[]> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        currencyCode: true,
        inventoryIntelligenceMode: true,
        inventoryRestockLeadDays: true,
        inventoryLowStockThreshold: true,
      },
    });
    if (!store || store.inventoryIntelligenceMode !== 'TRUSTED') return [];

    const to = this.now();
    const from = new Date(to.getTime() - WINDOW_DAYS * DAY_MS);
    const [commerceRows, inventoryRows] = await Promise.all([
      this.commerce.getProductEvidenceAggregates({
        storeId,
        currency: store.currencyCode,
        from,
        to,
      }),
      this.commerce.getInventoryEvidenceAggregates(storeId),
    ]);
    const salesByProduct = new Map(commerceRows.map((row) => [row.productId, row]));

    return inventoryRows.flatMap((inventory): RankedRecommendation[] => {
      const sales = salesByProduct.get(inventory.productId);
      const recentUnitsPerDay = sales && sales.cogsUnits > 0 ? sales.cogsUnits / WINDOW_DAYS : null;
      const daysCover = recentUnitsPerDay && recentUnitsPerDay > 0
        ? Math.max(0, inventory.available) / recentUnitsPerDay
        : null;
      const lowStock = inventory.available <= store.inventoryLowStockThreshold;
      const replenishmentRisk = daysCover !== null && daysCover <= store.inventoryRestockLeadDays;
      if (!lowStock && !replenishmentRisk) return [];

      const productName = sales?.title ?? `Product ${inventory.productId}`;
      const externalEntityId = sales?.shopifyProductId ?? inventory.productId;
      const stockout = inventory.available <= 0;
      const coverRatio = daysCover === null || store.inventoryRestockLeadDays <= 0
        ? 1
        : daysCover / store.inventoryRestockLeadDays;
      const urgencyScore = stockout ? 1 : clamp01(1 - coverRatio + (lowStock ? 0.45 : 0.25));
      const impactScore = clamp01(0.45 + Math.min(0.4, (sales?.netUnits ?? 0) / 50));
      const confidenceScore = recentUnitsPerDay === null ? 0.72 : 0.9;
      const severity = stockout || (daysCover !== null && daysCover <= Math.max(1, store.inventoryRestockLeadDays * 0.35))
        ? ('CRITICAL' as const)
        : ('HIGH' as const);

      const recommendation: RecommendationDraft = {
        ruleId: 'inventory_runway_risk',
        ruleVersion: '2',
        category: 'INVENTORY_RISK',
        severity,
        entityType: 'PRODUCT',
        entityId: inventory.productId,
        externalEntityId,
        entityName: productName,
        title: stockout ? 'Product is out of stock' : 'Restock timing is now at risk',
        summary: daysCover === null
          ? `Available stock is at or below your ${store.inventoryLowStockThreshold}-unit low-stock threshold.`
          : `At the recent observed selling rate, stock covers about ${daysCover.toFixed(1)} days while your normal replenishment takes ${store.inventoryRestockLeadDays} days.`,
        suggestedAction: stockout
          ? 'Replenish this product or stop demand-driving activity until stock is available again.'
          : `Start replenishment now or protect demand so stock lasts through the normal ${store.inventoryRestockLeadDays}-day restock window.`,
        impactScore,
        confidenceScore,
        urgencyScore,
        evidenceQuality: recentUnitsPerDay === null ? 'MEDIUM' : 'HIGH',
        attributionPrecision: 'SHOPIFY_COMMERCE',
        limitations: recentUnitsPerDay === null
          ? [{ code: 'VELOCITY_UNAVAILABLE', message: 'Recent selling velocity is too sparse for a days-of-cover estimate, so this finding is based on the merchant low-stock threshold.' }]
          : [],
        observationStart: from,
        observationEnd: to,
        comparisonStart: null,
        comparisonEnd: null,
        evidence: {
          source: 'SHOPIFY_INVENTORY_AND_OBSERVED_SALES',
          stockAvailable: inventory.available,
          lowStockThreshold: store.inventoryLowStockThreshold,
          recentUnitsPerDay,
          daysCover,
          restockLeadDays: store.inventoryRestockLeadDays,
          lowStock,
          replenishmentRisk,
          interpretation: 'Days of cover uses recent observed selling velocity. It is not a demand forecast.',
        },
      };
      return [{ ...recommendation, priority: impactScore * confidenceScore * urgencyScore }];
    });
  }
}

export const merchantInventoryRiskService = new MerchantInventoryRiskService();
