import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export type AnalyticsMetaAccount = {
  metaAdAccountId: string;
  name: string;
  currency: string;
  timezoneName: string | null;
  status: string | null;
  lastSyncedAt: Date | null;
};

export async function loadSelectedMetaAccounts(storeId: string, selectedAccountIds: string[]) {
  if (selectedAccountIds.length === 0) return [] as AnalyticsMetaAccount[];
  const rows = await prisma.metaAdAccount.findMany({
    where: { storeId, metaAccountId: { in: selectedAccountIds } },
    orderBy: [{ name: 'asc' }, { metaAccountId: 'asc' }],
    select: {
      metaAccountId: true,
      name: true,
      currency: true,
      timezoneName: true,
      status: true,
      lastSyncedAt: true,
    },
  });
  return rows.map((row) => ({
    metaAdAccountId: row.metaAccountId,
    name: row.name,
    currency: row.currency,
    timezoneName: row.timezoneName,
    status: row.status,
    lastSyncedAt: row.lastSyncedAt,
  }));
}

export function resolveMetaAccountScope(selectedAccountIds: string[], adAccountId?: string) {
  if (!adAccountId) return selectedAccountIds;
  if (!selectedAccountIds.includes(adAccountId)) {
    throw new AppError('Meta ad account is not selected for this store', 400, 'META_AD_ACCOUNT_NOT_SELECTED');
  }
  return [adAccountId];
}
