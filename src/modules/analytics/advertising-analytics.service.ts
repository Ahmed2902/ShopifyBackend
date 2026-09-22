import { AppError } from '../../errors/app-error.js';
import {
  aggregateMeta,
  emptyMetaMetrics,
  metricChanges,
  type MetaMetricRow,
  type MetaMetrics,
} from './analytics.metrics.js';
import {
  AdvertisingAnalyticsReadRepository,
  type AdvertisingOverviewAggregateRow,
  type AdvertisingOverviewPeriod,
} from './advertising-analytics.read.repository.js';
import type {
  AdvertisingAnalyticsRepository,
  AdvertisingMetaFilter,
} from './advertising-analytics.repository.js';
import {
  AdvertisingEntityAnalyticsReadRepository,
  type AdvertisingEntityAggregateRow,
  type AdvertisingEntityKind,
  type AdvertisingEntityPeriod,
} from './advertising-entity-analytics.read.repository.js';
import type { AnalyticsRepository } from './analytics.repository.js';
import { inRange, pagination, splitMeta, windowResponse } from './analytics.shared.js';
import type { AnalyticsWindows } from './analytics.shared.js';
import { CanonicalCreativeVideoRetentionService } from './canonical-creative-video-retention.service.js';
import { CreativeAdvertisingReadRepository } from './creative-advertising.read.repository.js';
import type { CreativeVideoRetentionService } from './creative-video-retention.service.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;
type CreativeMetaRow = Awaited<ReturnType<CreativeAdvertisingReadRepository['getRows']>>[number];

type MetaKind = 'CAMPAIGN' | 'ADSET' | 'AD';
type MetaFilter = AdvertisingMetaFilter;

function filter(kind: MetaKind, ids: string[]): MetaFilter {
  if (kind === 'CAMPAIGN') return { campaignIds: ids };
  if (kind === 'ADSET') return { adSetIds: ids };
  return { adIds: ids };
}

function daily<T extends MetaMetricRow & { date: Date }>(rows: T[]) {
  const groups = new Map<string, T[]>();
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

function splitCreative(rows: CreativeMetaRow[], windows: AnalyticsWindows) {
  return {
    current: rows.filter((row) =>
      inRange(row.date, windows.current.metaFrom, windows.current.metaTo),
    ),
    comparison: rows.filter((row) =>
      inRange(row.date, windows.comparison.metaFrom, windows.comparison.metaTo),
    ),
  };
}

function aggregateMetrics(row: {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  weightedFrequency: number;
} | undefined): MetaMetrics {
  if (!row) return emptyMetaMetrics();
  return {
    spend: row.spend,
    impressions: row.impressions,
    clicks: row.clicks,
    purchases: row.purchases,
    purchaseValue: row.purchaseValue,
    providerRoas: row.spend > 0 ? row.purchaseValue / row.spend : null,
    cpa: row.purchases > 0 ? row.spend / row.purchases : null,
    ctr: row.impressions > 0 ? row.clicks / row.impressions : null,
    cpc: row.clicks > 0 ? row.spend / row.clicks : null,
    cpm: row.impressions > 0 ? (row.spend / row.impressions) * 1_000 : null,
    averageDailyFrequency:
      row.impressions > 0 ? row.weightedFrequency / row.impressions : null,
  };
}

function overviewMetrics(row: AdvertisingOverviewAggregateRow | undefined): MetaMetrics {
  return aggregateMetrics(row);
}

function entityRow(
  rows: AdvertisingEntityAggregateRow[],
  entityId: string,
  period: AdvertisingEntityPeriod,
) {
  return rows.find((row) => row.entityId === entityId && row.period === period);
}

export class AdvertisingAnalyticsService {
  constructor(
    private readonly repository: AdvertisingAnalyticsRepository,
    private readonly readRepository: AdvertisingAnalyticsReadRepository =
      new AdvertisingAnalyticsReadRepository(),
    private readonly videoRetentionService: CreativeVideoRetentionService =
      new CanonicalCreativeVideoRetentionService(),
    private readonly creativeReadRepository: CreativeAdvertisingReadRepository =
      new CreativeAdvertisingReadRepository(),
    private readonly entityReadRepository: AdvertisingEntityAnalyticsReadRepository =
      new AdvertisingEntityAnalyticsReadRepository(),
  ) {}

  async overview(store: StoreContext, windows: AnalyticsWindows) {
    const selectedAccounts = store.metaConnection?.selectedAdAccountIds ?? [];
    const [rows, overviewMeta] = await Promise.all([
      this.readRepository.getOverviewAggregateRows({
        storeId: store.id,
        selectedAccountIds: selectedAccounts,
        currentFrom: windows.current.metaFrom,
        currentTo: windows.current.metaTo,
        comparisonFrom: windows.comparison.metaFrom,
        comparisonTo: windows.comparison.metaTo,
      }),
      this.readRepository.getOverviewMeta(store.id, selectedAccounts),
    ]);
    const rowFor = (period: AdvertisingOverviewPeriod, currency: string) =>
      rows.find((row) => row.period === period && row.accountCurrency === currency);
    const currencies = new Set(rows.map((row) => row.accountCurrency));
    const connectionStatus = store.metaConnection?.status ?? 'DISCONNECTED';

    return {
      window: windowResponse(windows),
      connection: {
        connected: connectionStatus === 'ACTIVE',
        status: connectionStatus,
        configured: selectedAccounts.length > 0,
      },
      selectedAdAccounts: selectedAccounts.length,
      entityCounts: {
        campaigns: overviewMeta.campaigns,
        ads: overviewMeta.ads,
      },
      lastInsightsSyncedAt: overviewMeta.lastInsightsSyncedAt,
      attributionSettings: [
        ...new Set(
          rows
            .filter((row) => row.period === 'CURRENT')
            .flatMap((row) => row.attributionSettings),
        ),
      ].sort(),
      currencies: [...currencies].sort().map((currency) => {
        const current = overviewMetrics(rowFor('CURRENT', currency));
        const comparison = overviewMetrics(rowFor('COMPARISON', currency));
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
    const creativeIds = page.items.map((item) => item.id);
    const [rows, videoRetention] = await Promise.all([
      this.entityReadRepository.getAggregateRows({
        storeId: store.id,
        selectedAccountIds: selected,
        entityIds: creativeIds,
        kind: 'CREATIVE',
        currentFrom: windows.current.metaFrom,
        currentTo: windows.current.metaTo,
        comparisonFrom: windows.comparison.metaFrom,
        comparisonTo: windows.comparison.metaTo,
      }),
      this.videoRetentionService.forCreatives({
        storeId: store.id,
        selectedAccountIds: selected,
        windows,
        creatives: page.items,
      }),
    ]);

    return {
      window: windowResponse(windows),
      pagination: pagination(pageNumber, limit, page.total),
      items: page.items.map((entity) => {
        const currentMetrics = aggregateMetrics(entityRow(rows, entity.id, 'CURRENT'));
        const comparisonMetrics = aggregateMetrics(entityRow(rows, entity.id, 'COMPARISON'));
        const currency =
          entityRow(rows, entity.id, 'CURRENT')?.accountCurrency ??
          entityRow(rows, entity.id, 'COMPARISON')?.accountCurrency ??
          null;
        return {
          entity,
          currency,
          current: currentMetrics,
          comparison: comparisonMetrics,
          change: metricChanges(currentMetrics, comparisonMetrics),
          videoRetention: videoRetention.get(entity.id) ?? null,
        };
      }),
    };
  }

  private async listResult<T extends { id: string }>(
    store: StoreContext,
    windows: AnalyticsWindows,
    page: { total: number; items: T[] },
    kind: AdvertisingEntityKind,
    pageNumber: number,
    limit: number,
  ) {
    const ids = page.items.map((item) => item.id);
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    const rows = await this.entityReadRepository.getAggregateRows({
      storeId: store.id,
      selectedAccountIds: selected,
      entityIds: ids,
      kind,
      currentFrom: windows.current.metaFrom,
      currentTo: windows.current.metaTo,
      comparisonFrom: windows.comparison.metaFrom,
      comparisonTo: windows.comparison.metaTo,
    });

    return {
      window: windowResponse(windows),
      pagination: pagination(pageNumber, limit, page.total),
      items: page.items.map((entity) => {
        const currentMetrics = aggregateMetrics(entityRow(rows, entity.id, 'CURRENT'));
        const comparisonMetrics = aggregateMetrics(entityRow(rows, entity.id, 'COMPARISON'));
        const currency =
          entityRow(rows, entity.id, 'CURRENT')?.accountCurrency ??
          entityRow(rows, entity.id, 'COMPARISON')?.accountCurrency ??
          null;
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
    if (!entity) {
      throw new AppError('creative not found', 404, 'META_ENTITY_NOT_FOUND');
    }

    const [rows, videoRetention] = await Promise.all([
      this.creativeReadRepository.getRows({
        storeId: store.id,
        selectedAccountIds: selected,
        creativeIds: [id],
        from: windows.comparison.metaFrom,
        to: windows.current.metaTo,
      }),
      this.videoRetentionService.forCreatives({
        storeId: store.id,
        selectedAccountIds: selected,
        windows,
        creatives: [entity],
      }),
    ]);
    const split = splitCreative(rows, windows);
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
      videoRetention: videoRetention.get(entity.id) ?? null,
    };
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
