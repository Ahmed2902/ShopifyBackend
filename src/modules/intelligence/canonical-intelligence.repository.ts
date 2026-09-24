import { AdvertisingIntelligenceReadRepository } from '../advertising/advertising-intelligence-read.repository.js';
import { IntelligenceRepository } from './intelligence.repository.js';

const PURCHASE_ACTION_TYPE = 'offsite_conversion.fb_pixel_purchase';

/**
 * Compatibility adapter for the existing deterministic rule layer.
 *
 * Paid-media metric/hierarchy evidence is sourced from canonical provider-neutral persistence.
 * Product mapping remains on the existing repository contract in this cutover checkpoint and is
 * moved behind the provider-neutral decision repository contract in the following slice.
 */
export class CanonicalIntelligenceRepository extends IntelligenceRepository {
  constructor(private readonly evidence = new AdvertisingIntelligenceReadRepository()) {
    super();
  }

  override async getMetaEvidenceRows(input: {
    storeId: string;
    selectedAccountIds: string[];
    productFrom: Date;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }) {
    const rows = await this.evidence.getEvidenceRows({
      storeId: input.storeId,
      provider: 'META',
      selectedAccountExternalIds: input.selectedAccountIds,
      productFrom: input.productFrom,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      comparisonFrom: input.comparisonFrom,
      comparisonTo: input.comparisonTo,
    });

    return rows.map((row) => ({
      bucket: row.bucket,
      sourceRowCount: row.sourceRowCount,
      date: row.date,
      syncedAt: row.syncedAt,
      accountCurrency: row.currency ?? '',
      spend: row.spend,
      impressions: row.impressions,
      clicks: row.clicks,
      frequency: row.frequency,
      campaign: row.campaign
        ? {
            id: row.campaign.id,
            metaCampaignId: row.campaign.externalId,
            name: row.campaign.name,
          }
        : null,
      ad: row.ad
        ? {
            id: row.ad.id,
            metaAdId: row.ad.externalId,
            name: row.ad.name,
            creative: row.ad.creative
              ? {
                  id: row.ad.creative.id,
                  metaCreativeId: row.ad.creative.externalId,
                  name: row.ad.creative.name,
                  title: row.ad.creative.title,
                }
              : null,
          }
        : null,
      actions: [
        {
          kind: 'ACTION' as const,
          actionType: PURCHASE_ACTION_TYPE,
          actionDestination: null,
          value: row.conversions,
        },
        {
          kind: 'ACTION_VALUE' as const,
          actionType: PURCHASE_ACTION_TYPE,
          actionDestination: null,
          value: row.conversionValue,
        },
      ],
    }));
  }
}
