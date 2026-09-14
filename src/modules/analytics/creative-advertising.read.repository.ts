import { prisma } from '../../lib/prisma.js';

export class CreativeAdvertisingReadRepository {
  getRows(input: {
    storeId: string;
    selectedAccountIds: string[];
    creativeIds: string[];
    from: Date;
    to: Date;
  }) {
    if (input.selectedAccountIds.length === 0 || input.creativeIds.length === 0) {
      return Promise.resolve([]);
    }

    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: input.from, lte: input.to },
        adAccount: {
          storeId: input.storeId,
          metaAccountId: { in: input.selectedAccountIds },
        },
        creativeIdSnapshot: { in: input.creativeIds },
      },
      select: {
        date: true,
        creativeIdSnapshot: true,
        accountCurrency: true,
        spend: true,
        impressions: true,
        clicks: true,
        frequency: true,
        attributionSetting: true,
        actions: {
          where: {
            kind: { in: ['ACTION', 'ACTION_VALUE', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS'] },
          },
          select: { kind: true, actionType: true, actionDestination: true, value: true },
        },
      },
      orderBy: [{ date: 'asc' }, { creativeIdSnapshot: 'asc' }],
    });
  }
}
