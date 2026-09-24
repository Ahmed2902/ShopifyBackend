import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { AdvertisingReadRepository } from '../advertising/advertising-read.repository.js';

export type ProductAdsPeriod = 'CURRENT' | 'COMPARISON';

export interface ProductAdsMetaAggregateRow {
  period: ProductAdsPeriod;
  adId: string | null;
  accountCurrency: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number | null;
  purchaseValue: number | null;
  weightedFrequency: number;
}

export interface ProductAdsMappingSummaryRow {
  metaAdId: string;
  productId: string;
  variantId: string | null;
  source: string;
  confidence: Prisma.Decimal;
  isMerchantConfirmed: boolean;
  product: {
    id: string;
    shopifyProductId: string;
    title: string;
    status: string;
    deletedAt: Date | null;
  };
}

export interface ProductAdsProductIdentity {
  id: string;
  shopifyProductId: string;
  title: string;
  status: string;
  deletedAt: Date | null;
}

/**
 * Product × Ads compatibility read surface backed by canonical paid-media persistence.
 * The public `metaAdId` name is retained for the current API contract, but its value now comes from
 * AdvertisingAd.providerEntityId and can be generalized without another storage migration.
 */
export class ProductAdsReadRepository {
  constructor(
    private readonly canonical: AdvertisingReadRepository = new AdvertisingReadRepository(),
  ) {}

  async getActiveMappingSummaries(
    storeId: string,
    selectedAccountIds: string[],
  ): Promise<ProductAdsMappingSummaryRow[]> {
    const rows = await this.canonical.getActiveProductMappings({
      storeId,
      provider: 'META',
      selectedAccountExternalIds: selectedAccountIds,
    });
    return rows.map((row) => ({
      metaAdId: row.adExternalId,
      productId: row.productId,
      variantId: row.variantId,
      source: row.source,
      confidence: row.confidence,
      isMerchantConfirmed: row.isMerchantConfirmed,
      product: row.product,
    }));
  }

  getProductIdentities(storeId: string, productIds: string[]): Promise<ProductAdsProductIdentity[]> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.product.findMany({
      where: { storeId, id: { in: ids } },
      select: {
        id: true,
        shopifyProductId: true,
        title: true,
        status: true,
        deletedAt: true,
      },
    });
  }

  async getMetaAdAggregates(input: {
    storeId: string;
    selectedAccountIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
    adIds?: string[];
  }): Promise<ProductAdsMetaAggregateRow[]> {
    const rows = await this.canonical.getAdAggregateRows({
      storeId: input.storeId,
      provider: 'META',
      selectedAccountExternalIds: input.selectedAccountIds,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      comparisonFrom: input.comparisonFrom,
      comparisonTo: input.comparisonTo,
      adIds: input.adIds,
    });
    return rows
      .filter((row): row is typeof row & { currency: string } => row.currency !== null)
      .map((row) => ({
        period: row.period,
        adId: row.adId,
        accountCurrency: row.currency,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        purchases: row.conversions,
        purchaseValue: row.conversionValue,
        weightedFrequency: row.weightedFrequency,
      }));
  }
}
