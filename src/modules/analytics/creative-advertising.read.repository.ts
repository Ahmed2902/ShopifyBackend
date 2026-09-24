import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

const PURCHASE_ACTION_TYPE = 'offsite_conversion.fb_pixel_purchase';

/**
 * Compatibility read for the current creative analytics service. Storage is canonical; the
 * synthetic purchase actions preserve the existing aggregateMeta contract until public DTOs are
 * renamed away from Meta-specific vocabulary.
 */
export class CreativeAdvertisingReadRepository {
  async getRows(input: {
    storeId: string;
    selectedAccountIds: string[];
    creativeIds: string[];
    from: Date;
    to: Date;
  }) {
    if (input.selectedAccountIds.length === 0 || input.creativeIds.length === 0) return [];

    const rows = await prisma.advertisingDailyMetric.findMany({
      where: {
        level: 'AD',
        date: { gte: input.from, lte: input.to },
        account: {
          storeId: input.storeId,
          provider: 'META',
          providerEntityId: { in: input.selectedAccountIds },
        },
        creativeIdSnapshot: { in: input.creativeIds },
      },
      select: {
        date: true,
        creativeIdSnapshot: true,
        currency: true,
        spend: true,
        impressions: true,
        clicks: true,
        frequency: true,
        conversions: true,
        conversionValue: true,
        providerMetrics: true,
      },
      orderBy: [{ date: 'asc' }, { creativeIdSnapshot: 'asc' }],
    });

    return rows.map((row) => {
      const providerMetrics =
        row.providerMetrics && typeof row.providerMetrics === 'object' && !Array.isArray(row.providerMetrics)
          ? (row.providerMetrics as Record<string, unknown>)
          : {};
      return {
        date: row.date,
        creativeIdSnapshot: row.creativeIdSnapshot,
        accountCurrency: row.currency ?? '',
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        frequency: row.frequency,
        attributionSetting:
          typeof providerMetrics.attributionSetting === 'string'
            ? providerMetrics.attributionSetting
            : null,
        actions: [
          {
            kind: 'ACTION' as const,
            actionType: PURCHASE_ACTION_TYPE,
            actionDestination: null,
            value: new Prisma.Decimal(row.conversions ?? 0),
          },
          {
            kind: 'ACTION_VALUE' as const,
            actionType: PURCHASE_ACTION_TYPE,
            actionDestination: null,
            value: new Prisma.Decimal(row.conversionValue ?? 0),
          },
        ],
      };
    });
  }
}
