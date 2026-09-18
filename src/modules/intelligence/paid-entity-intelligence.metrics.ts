import type { IntelligenceRepository } from './intelligence.repository.js';
import type { HistoricalMetrics } from './intelligence.types.js';

type MetaRow = Awaited<ReturnType<IntelligenceRepository['getMetaEvidenceRows']>>[number];

export interface PaidEntityEvidence {
  entityId: string;
  externalEntityId: string;
  name: string;
  currency: string;
  spendShare: number;
  current: HistoricalMetrics;
  comparison: HistoricalMetrics;
}

function empty(): HistoricalMetrics {
  return {
    spend: 0,
    impressions: 0,
    reach: null,
    clicks: 0,
    purchases: 0,
    purchaseValue: 0,
    roas: null,
    cpa: null,
    ctr: null,
    cpc: null,
    cpm: null,
    frequency: null,
  };
}

function purchaseValue(row: MetaRow, kind: 'ACTION' | 'ACTION_VALUE') {
  return row.actions
    .filter((action) => action.kind === kind)
    .reduce((sum, action) => sum + Number(action.value || 0), 0);
}

function rowMetrics(row: MetaRow): HistoricalMetrics {
  const spend = Number(row.spend || 0);
  const impressions = Number(row.impressions || 0);
  const clicks = Number(row.clicks || 0);
  const purchases = purchaseValue(row, 'ACTION');
  const value = purchaseValue(row, 'ACTION_VALUE');
  return {
    spend,
    impressions,
    reach: null,
    clicks,
    purchases,
    purchaseValue: value,
    roas: spend > 0 ? value / spend : null,
    cpa: purchases > 0 ? spend / purchases : null,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1_000 : null,
    frequency: row.frequency,
  };
}

export function buildAdEvidence(rows: MetaRow[]): PaidEntityEvidence[] {
  const groups = new Map<
    string,
    {
      entityId: string;
      externalEntityId: string;
      name: string;
      currency: string;
      current: HistoricalMetrics;
      comparison: HistoricalMetrics;
    }
  >();
  const currentSpendByCurrency = new Map<string, number>();

  for (const row of rows) {
    if (!row.ad || row.bucket === 'PRODUCT_ONLY') continue;
    const key = `${row.accountCurrency}:${row.ad.id}`;
    const group = groups.get(key) ?? {
      entityId: row.ad.id,
      externalEntityId: row.ad.metaAdId,
      name: row.ad.name,
      currency: row.accountCurrency,
      current: empty(),
      comparison: empty(),
    };
    const metrics = rowMetrics(row);
    if (row.bucket === 'CURRENT') {
      group.current = metrics;
      currentSpendByCurrency.set(
        row.accountCurrency,
        (currentSpendByCurrency.get(row.accountCurrency) ?? 0) + metrics.spend,
      );
    } else {
      group.comparison = metrics;
    }
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => ({
    ...group,
    spendShare:
      (currentSpendByCurrency.get(group.currency) ?? 0) > 0
        ? group.current.spend / (currentSpendByCurrency.get(group.currency) ?? 1)
        : 0,
  }));
}
