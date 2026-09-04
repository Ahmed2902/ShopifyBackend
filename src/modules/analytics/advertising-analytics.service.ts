import { AppError } from '../../errors/app-error.js';
import {
  aggregateMeta,
  aggregateMetaBy,
  emptyMetaMetrics,
  metricChanges,
} from './analytics.metrics.js';
import type { AnalyticsRepository } from './analytics.repository.js';
import { groupMetaByCurrency, pagination, splitMeta, windowResponse } from './analytics.shared.js';
import type { AnalyticsWindows } from './analytics.shared.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;
type MetaRow = Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>[number];

type MetaKind = 'CAMPAIGN' | 'ADSET' | 'AD' | 'CREATIVE';
type MetaFilter = Parameters<AnalyticsRepository['getMetaRows']>[4];

function selector(kind: MetaKind): (row: MetaRow) => string | null {
  if (kind === 'CAMPAIGN') return (row) => row.campaign?.id ?? null;
  if (kind === 'ADSET') return (row) => row.adSet?.id ?? null;
  if (kind === 'AD') return (row) => row.ad?.id ?? null;
  return (row) => row.ad?.creative?.id ?? null;
}

function filter(kind: MetaKind, ids: string[]): MetaFilter {
  if (kind === 'CAMPAIGN') return { campaignIds: ids };
  if (kind === 'ADSET') return { adSetIds: ids };
  if (kind === 'AD') return { adIds: ids };
  return { creativeIds: ids };
}

function daily(rows: MetaRow[]) {
  const groups = new Map<string, MetaRow[]>();
  for (const row of rows) {
    const key = row.date.toISOString().slice(0, 10);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, values]) => ({ date, ...aggregateMeta(values) }));
}

export class AdvertisingAnalyticsService {
  constructor(private readonly repository: AnalyticsRepository) {}

  async overview(store: StoreContext, windows: AnalyticsWindows) {
    const selectedAccounts = store.metaConnection?.selectedAdAccountIds ?? [];
    const [rows, latestInsight] = await Promise.all([
      this.repository.getMetaRows(
        store.id,
        selectedAccounts,
        windows.comparison.metaFrom,
        windows.current.metaTo,
      ),
      this.repository.getLatestMetaInsightSyncedAt(store.id, selectedAccounts),
    ]);
    const split = splitMeta(rows, windows);
    const currentByCurrency = groupMetaByCurrency(split.current);
    const comparisonByCurrency = groupMetaByCurrency(split.comparison);
    const currencies = new Set([...currentByCurrency.keys(), ...comparisonByCurrency.keys()]);

    return {
      window: windowResponse(windows),
      selectedAdAccounts: selectedAccounts.length,
      lastInsightsSyncedAt: latestInsight?.syncedAt ?? null,
      attributionSettings: [
        ...new Set(split.current.map((row) => row.attributionSetting).filter(Boolean)),
      ],
      currencies: [...currencies].sort().map((currency) => {
        const current = aggregateMeta(currentByCurrency.get(currency) ?? []);
        const comparison = aggregateMeta(comparisonByCurrency.get(currency) ?? []);
        return { currency, current, comparison, change: metricChanges(current, comparison) };
      }),
    };
  }

  campaigns(store: StoreContext, windows: AnalyticsWindows, page: number, limit: number) {
    return this.listCampaigns(store, windows, page, limit);
  }

  adSets(store: StoreContext, windows: AnalyticsWindows, page: number, limit: number) {
    return this.listAdSets(store, windows, page, limit);
  }

  ads(store: StoreContext, windows: AnalyticsWindows, page: number, limit: number) {
    return this.listAds(store, windows, page, limit);
  }

  creatives(store: StoreContext, windows: AnalyticsWindows, page: number, limit: number) {
    return this.listCreatives(store, windows, page, limit);
  }

  campaign(store: StoreContext, windows: AnalyticsWindows, id: string) {
    return this.campaignDetail(store, windows, id);
  }

  adSet(store: StoreContext, windows: AnalyticsWindows, id: string) {
    return this.adSetDetail(store, windows, id);
  }

  ad(store: StoreContext, windows: AnalyticsWindows, id: string) {
    return this.adDetail(store, windows, id);
  }

  creative(store: StoreContext, windows: AnalyticsWindows, id: string) {
    return this.creativeDetail(store, windows, id);
  }

  private async listCampaigns(
    store: StoreContext,
    windows: AnalyticsWindows,
    pageNumber: number,
    limit: number,
  ) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const page = await this.repository.getCampaignsPage(store.id, selected, pageNumber, limit);
    return this.listResult(store, windows, page, 'CAMPAIGN', pageNumber, limit);
  }

  private async listAdSets(
    store: StoreContext,
    windows: AnalyticsWindows,
    pageNumber: number,
    limit: number,
  ) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const page = await this.repository.getAdSetsPage(store.id, selected, pageNumber, limit);
    return this.listResult(store, windows, page, 'ADSET', pageNumber, limit);
  }

  private async listAds(
    store: StoreContext,
    windows: AnalyticsWindows,
    pageNumber: number,
    limit: number,
  ) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const page = await this.repository.getAdsPage(store.id, selected, pageNumber, limit);
    return this.listResult(store, windows, page, 'AD', pageNumber, limit);
  }

  private async listCreatives(
    store: StoreContext,
    windows: AnalyticsWindows,
    pageNumber: number,
    limit: number,
  ) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const page = await this.repository.getCreativesPage(store.id, selected, pageNumber, limit);
    return this.listResult(store, windows, page, 'CREATIVE', pageNumber, limit);
  }

  private async listResult<T extends { id: string }>(
    store: StoreContext,
    windows: AnalyticsWindows,
    page: { total: number; items: T[] },
    kind: MetaKind,
    pageNumber: number,
    limit: number,
  ) {
    const ids = page.items.map((item) => item.id);
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const rows = await this.repository.getMetaRows(
      store.id,
      selected,
      windows.comparison.metaFrom,
      windows.current.metaTo,
      filter(kind, ids),
    );
    const split = splitMeta(rows, windows);
    const entityId = selector(kind);
    const current = aggregateMetaBy(split.current, entityId);
    const comparison = aggregateMetaBy(split.comparison, entityId);

    return {
      window: windowResponse(windows),
      pagination: pagination(pageNumber, limit, page.total),
      items: page.items.map((entity) => {
        const currentMetrics = current.get(entity.id) ?? emptyMetaMetrics();
        const comparisonMetrics = comparison.get(entity.id) ?? emptyMetaMetrics();
        const currency = rows.find((row) => entityId(row) === entity.id)?.accountCurrency ?? null;
        return {
          entity,
          currency,
          current: currentMetrics,
          comparison: comparisonMetrics,
          change: metricChanges(currentMetrics, comparisonMetrics),
        };
      }),
    };
  }

  private async campaignDetail(store: StoreContext, windows: AnalyticsWindows, id: string) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const entity = await this.repository.getCampaign(store.id, selected, id);
    return this.detailResult(store, windows, entity, id, 'CAMPAIGN');
  }

  private async adSetDetail(store: StoreContext, windows: AnalyticsWindows, id: string) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const entity = await this.repository.getAdSet(store.id, selected, id);
    return this.detailResult(store, windows, entity, id, 'ADSET');
  }

  private async adDetail(store: StoreContext, windows: AnalyticsWindows, id: string) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const entity = await this.repository.getAd(store.id, selected, id);
    return this.detailResult(store, windows, entity, id, 'AD');
  }

  private async creativeDetail(store: StoreContext, windows: AnalyticsWindows, id: string) {
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const entity = await this.repository.getCreative(store.id, selected, id);
    return this.detailResult(store, windows, entity, id, 'CREATIVE');
  }

  private async detailResult<T>(
    store: StoreContext,
    windows: AnalyticsWindows,
    entity: T | null,
    id: string,
    kind: MetaKind,
  ) {
    if (!entity) {
      throw new AppError(`${kind.toLowerCase()} not found`, 404, 'META_ENTITY_NOT_FOUND');
    }
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const rows = await this.repository.getMetaRows(
      store.id,
      selected,
      windows.comparison.metaFrom,
      windows.current.metaTo,
      filter(kind, [id]),
    );
    const split = splitMeta(rows, windows);
    const current = aggregateMeta(split.current);
    const comparison = aggregateMeta(split.comparison);

    return {
      window: windowResponse(windows),
      entity,
      currency: rows[0]?.accountCurrency ?? null,
      current,
      comparison,
      change: metricChanges(current, comparison),
      daily: daily(split.current),
      attributionSettings: [
        ...new Set(split.current.map((row) => row.attributionSetting).filter(Boolean)),
      ],
    };
  }
}
