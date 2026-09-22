import { AdvertisingReadRepository } from '../advertising/advertising-read.repository.js';

export type AdvertisingEntityKind = 'CAMPAIGN' | 'ADSET' | 'AD' | 'CREATIVE';
export type AdvertisingEntityPeriod = 'CURRENT' | 'COMPARISON';

export interface AdvertisingEntityAggregateRow {
  period: AdvertisingEntityPeriod;
  entityId: string;
  accountCurrency: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  weightedFrequency: number;
}

export class AdvertisingEntityAnalyticsReadRepository {
  constructor(
    private readonly canonical: AdvertisingReadRepository = new AdvertisingReadRepository(),
  ) {}

  async getAggregateRows(input: {
    storeId: string;
    selectedAccountIds: string[];
    entityIds: string[];
    kind: AdvertisingEntityKind;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<AdvertisingEntityAggregateRow[]> {
    const rows = await this.canonical.getEntityAggregateRows({
      storeId: input.storeId,
      provider: 'META',
      selectedAccountExternalIds: input.selectedAccountIds,
      entityIds: input.entityIds,
      kind: input.kind === 'ADSET' ? 'GROUP' : input.kind,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      comparisonFrom: input.comparisonFrom,
      comparisonTo: input.comparisonTo,
    });

    return rows
      .filter((row): row is typeof row & { currency: string } => row.currency !== null)
      .map((row) => ({
        period: row.period,
        entityId: row.entityId,
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
