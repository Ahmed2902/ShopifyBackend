import { prisma } from '../../lib/prisma.js';
import type { IntelligenceDataset, ProductSignal, ProviderSignal } from './intelligence.types.js';

function numeric(value: { toString(): string } | string | number | bigint | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = Number(value.toString());
  return Number.isFinite(parsed) ? parsed : 0;
}

function purchaseMetric(
  actions: Array<{ kind: string; actionType: string; value: { toString(): string } }>,
  preferred: string,
  fallback: string,
): number {
  const purchaseRows = actions.filter((action) => action.actionType.toLowerCase().includes('purchase'));
  const rows = purchaseRows.filter((action) => action.kind === preferred);
  const selected = rows.length > 0 ? rows : purchaseRows.filter((action) => action.kind === fallback);
  return selected.reduce((max, action) => Math.max(max, numeric(action.value)), 0);
}

function emptyProvider(provider: ProviderSignal['provider'], currency: string | null): ProviderSignal {
  return {
    provider,
    currency,
    ads: 0,
    activeAds: 0,
    spend: 0,
    impressions: 0,
    clicks: 0,
    conversions: 0,
    conversionValue: 0,
    roas: null,
  };
}

export class IntelligenceRepository {
  async load(storeId: string, from: Date, to: Date): Promise<IntelligenceDataset | null> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        shopifyConnection: { select: { status: true } },
        metaConnection: { select: { status: true, selectedAdAccountIds: true } },
        tiktokConnection: { select: { status: true, selectedAdvertiserIds: true } },
      },
    });
    if (!store) return null;

    const metaAccountIds = store.metaConnection?.selectedAdAccountIds ?? [];
    const tiktokAdvertiserIds = store.tiktokConnection?.selectedAdvertiserIds ?? [];

    const [metaMappings, tiktokMappings] = await Promise.all([
      metaAccountIds.length === 0
        ? Promise.resolve([])
        : prisma.adProductMapping.findMany({
            where: {
              validUntil: null,
              product: { storeId, deletedAt: null },
              ad: { deletedAt: null, adAccount: { storeId, metaAccountId: { in: metaAccountIds } } },
            },
            select: {
              productId: true,
              confidence: true,
              isMerchantConfirmed: true,
              ad: {
                select: {
                  id: true,
                  metaAdId: true,
                  effectiveStatus: true,
                  adAccount: { select: { currency: true } },
                  insights: {
                    where: { level: 'AD', date: { gte: from, lte: to } },
                    select: {
                      spend: true,
                      impressions: true,
                      clicks: true,
                      actions: { select: { kind: true, actionType: true, value: true } },
                    },
                  },
                },
              },
            },
          }),
      tiktokAdvertiserIds.length === 0
        ? Promise.resolve([])
        : prisma.tikTokAdProductMapping.findMany({
            where: {
              validUntil: null,
              product: { storeId, deletedAt: null },
              ad: { deletedAt: null, advertiser: { storeId, advertiserId: { in: tiktokAdvertiserIds } } },
            },
            select: {
              productId: true,
              confidence: true,
              isMerchantConfirmed: true,
              ad: {
                select: {
                  id: true,
                  tiktokAdId: true,
                  operationStatus: true,
                  advertiser: { select: { currency: true } },
                  insights: {
                    where: { level: 'AD', date: { gte: from, lte: to } },
                    select: {
                      spend: true,
                      impressions: true,
                      clicks: true,
                      conversions: true,
                      conversionValue: true,
                      roas: true,
                    },
                  },
                },
              },
            },
          }),
    ]);

    const productIds = [
      ...new Set([...metaMappings.map((item) => item.productId), ...tiktokMappings.map((item) => item.productId)]),
    ];
    if (productIds.length === 0) {
      return {
        connections: {
          shopify: store.shopifyConnection?.status ?? null,
          meta: store.metaConnection?.status ?? null,
          tiktok: store.tiktokConnection?.status ?? null,
        },
        products: [],
      };
    }

    const [products, orderLines] = await Promise.all([
      prisma.product.findMany({
        where: { id: { in: productIds }, storeId, deletedAt: null },
        select: {
          id: true,
          title: true,
          status: true,
          tracksInventory: true,
          variants: {
            where: { deletedAt: null },
            select: {
              inventoryItem: {
                select: {
                  tracked: true,
                  currentLevels: {
                    where: { location: { storeId, deletedAt: null, isActive: true } },
                    select: { available: true, incoming: true },
                  },
                },
              },
              restockLines: {
                where: {
                  restock: {
                    storeId,
                    status: { in: ['ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED'] },
                    expectedAt: { not: null },
                  },
                },
                select: { restock: { select: { expectedAt: true } } },
              },
            },
          },
        },
      }),
      prisma.orderLineItem.findMany({
        where: {
          productId: { in: productIds },
          order: {
            storeId,
            isTest: false,
            OR: [
              { processedAt: { gte: from, lte: to } },
              { processedAt: null, shopifyCreatedAt: { gte: from, lte: to } },
            ],
          },
        },
        select: { productId: true, currentQuantity: true, orderId: true },
      }),
    ]);

    const sales = new Map<string, { units: number; orders: Set<string> }>();
    for (const row of orderLines) {
      if (!row.productId) continue;
      const current = sales.get(row.productId) ?? { units: 0, orders: new Set<string>() };
      current.units += Math.max(0, row.currentQuantity);
      current.orders.add(row.orderId);
      sales.set(row.productId, current);
    }

    const mappingCounts = new Map<string, number>();
    for (const mapping of metaMappings) mappingCounts.set(`META:${mapping.ad.id}`, (mappingCounts.get(`META:${mapping.ad.id}`) ?? 0) + 1);
    for (const mapping of tiktokMappings) mappingCounts.set(`TIKTOK:${mapping.ad.id}`, (mappingCounts.get(`TIKTOK:${mapping.ad.id}`) ?? 0) + 1);

    const signals = new Map<string, ProductSignal>();
    for (const product of products) {
      let available = 0;
      let incoming = 0;
      let tracked = false;
      let nextRestockAt: Date | null = null;
      for (const variant of product.variants) {
        if (variant.inventoryItem?.tracked) tracked = true;
        for (const level of variant.inventoryItem?.currentLevels ?? []) {
          available += level.available;
          incoming += level.incoming;
        }
        for (const line of variant.restockLines) {
          const expectedAt = line.restock.expectedAt;
          if (expectedAt && (!nextRestockAt || expectedAt < nextRestockAt)) nextRestockAt = expectedAt;
        }
      }
      const commerce = sales.get(product.id);
      signals.set(product.id, {
        productId: product.id,
        title: product.title,
        status: product.status,
        tracksInventory: product.tracksInventory || tracked,
        available,
        incoming,
        nextRestockAt,
        unitsSold: commerce?.units ?? 0,
        orderCount: commerce?.orders.size ?? 0,
        mappingConfidence: null,
        mappingConfirmed: false,
        sharedAdMapping: false,
        providers: [],
      });
    }

    const providerByProduct = new Map<string, Map<string, ProviderSignal>>();
    const confidenceByProduct = new Map<string, number[]>();

    const providerFor = (productId: string, provider: ProviderSignal['provider'], currency: string | null) => {
      let providers = providerByProduct.get(productId);
      if (!providers) {
        providers = new Map();
        providerByProduct.set(productId, providers);
      }
      const key = `${provider}:${currency ?? 'UNKNOWN'}`;
      let result = providers.get(key);
      if (!result) {
        result = emptyProvider(provider, currency);
        providers.set(key, result);
      }
      return result;
    };

    for (const mapping of metaMappings) {
      const product = signals.get(mapping.productId);
      if (!product) continue;
      const provider = providerFor(mapping.productId, 'META', mapping.ad.adAccount.currency);
      provider.ads += 1;
      if ((mapping.ad.effectiveStatus ?? '').toUpperCase().includes('ACTIVE')) provider.activeAds += 1;
      for (const insight of mapping.ad.insights) {
        provider.spend += numeric(insight.spend);
        provider.impressions += numeric(insight.impressions);
        provider.clicks += numeric(insight.clicks);
        provider.conversions += purchaseMetric(insight.actions, 'CONVERSION', 'ACTION');
        provider.conversionValue += purchaseMetric(insight.actions, 'CONVERSION_VALUE', 'ACTION_VALUE');
      }
      const confidence = mapping.isMerchantConfirmed ? 1 : numeric(mapping.confidence);
      confidenceByProduct.set(mapping.productId, [...(confidenceByProduct.get(mapping.productId) ?? []), confidence]);
      product.mappingConfirmed ||= mapping.isMerchantConfirmed;
      product.sharedAdMapping ||= (mappingCounts.get(`META:${mapping.ad.id}`) ?? 0) > 1;
    }

    for (const mapping of tiktokMappings) {
      const product = signals.get(mapping.productId);
      if (!product) continue;
      const provider = providerFor(mapping.productId, 'TIKTOK', mapping.ad.advertiser.currency);
      provider.ads += 1;
      if ((mapping.ad.operationStatus ?? '').toUpperCase().includes('ENABLE')) provider.activeAds += 1;
      let reportedRoasWeighted = 0;
      let reportedRoasSpend = 0;
      for (const insight of mapping.ad.insights) {
        const spend = numeric(insight.spend);
        provider.spend += spend;
        provider.impressions += numeric(insight.impressions);
        provider.clicks += numeric(insight.clicks);
        provider.conversions += numeric(insight.conversions);
        provider.conversionValue += numeric(insight.conversionValue);
        if (insight.roas !== null) {
          reportedRoasWeighted += numeric(insight.roas) * Math.max(spend, 1);
          reportedRoasSpend += Math.max(spend, 1);
        }
      }
      if (provider.conversionValue <= 0 && reportedRoasSpend > 0) provider.roas = reportedRoasWeighted / reportedRoasSpend;
      const confidence = mapping.isMerchantConfirmed ? 1 : numeric(mapping.confidence);
      confidenceByProduct.set(mapping.productId, [...(confidenceByProduct.get(mapping.productId) ?? []), confidence]);
      product.mappingConfirmed ||= mapping.isMerchantConfirmed;
      product.sharedAdMapping ||= (mappingCounts.get(`TIKTOK:${mapping.ad.id}`) ?? 0) > 1;
    }

    for (const product of signals.values()) {
      const confidences = confidenceByProduct.get(product.productId) ?? [];
      product.mappingConfidence = confidences.length
        ? confidences.reduce((sum, value) => sum + value, 0) / confidences.length
        : null;
      product.providers = [...(providerByProduct.get(product.productId)?.values() ?? [])].map((provider) => ({
        ...provider,
        roas: provider.spend > 0 && provider.conversionValue > 0 ? provider.conversionValue / provider.spend : provider.roas,
      }));
    }

    return {
      connections: {
        shopify: store.shopifyConnection?.status ?? null,
        meta: store.metaConnection?.status ?? null,
        tiktok: store.tiktokConnection?.status ?? null,
      },
      products: [...signals.values()],
    };
  }
}
