import { AppError } from '../../errors/app-error.js';
import { memoizeRequestRead } from '../../lib/request-read-cache.js';
import { AdvertisingAnalyticsReadRepository } from './advertising-analytics.read.repository.js';
import { AdvertisingAnalyticsService } from './advertising-analytics.service.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { metricChanges, percentChange } from './analytics.metrics.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';
import { collectionAnalyticsReadService } from './collection-analytics.read.service.js';
import type { CollectionAnalyticsReadService } from './collection-analytics.read.service.js';
import { CommerceAnalyticsReadRepository } from './commerce-analytics.read.repository.js';
import { CommerceAnalyticsService } from './commerce-analytics.service.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;
type OrderHistorySync = NonNullable<StoreContext['shopifyConnection']>['syncRuns'][number];

/**
 * Stable analytics read side for Stride.
 *
 * Workspaces compose source-domain facts for cross-domain analytical use-cases without
 * creating a second write model or coupling backend contracts to the current UI layout.
 */
export class AnalyticsWorkspace {
  private readonly commerce: CommerceAnalyticsService;
  private readonly advertisingService: AdvertisingAnalyticsService;

  constructor(
    private readonly repository: AnalyticsRepository = new AnalyticsRepository(),
    advertisingReadRepository: AdvertisingAnalyticsReadRepository =
      new AdvertisingAnalyticsReadRepository(),
    commerceReadRepository?: CommerceAnalyticsReadRepository,
    private readonly collectionReadService?: CollectionAnalyticsReadService,
  ) {
    this.commerce = new CommerceAnalyticsService(repository, commerceReadRepository);
    this.advertisingService = new AdvertisingAnalyticsService(repository, advertisingReadRepository);
  }

  async overview(storeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const store = await this.loadStore(storeId);
    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const latestOrderHistoryAttempt = store.shopifyConnection?.syncRuns[0] ?? null;
    const [commerce, advertising, profitabilityBase, latestSuccessfulOrderHistory] =
      await Promise.all([
        this.commerce.summary(store, windows),
        this.advertisingService.overview(store, windows),
        this.commerce.profitabilityBase(store, windows),
        latestOrderHistoryAttempt?.status === 'SUCCEEDED'
          ? Promise.resolve(latestOrderHistoryAttempt)
          : memoizeRequestRead(`analytics:order-history:${storeId}`, () =>
              this.repository.getLatestSuccessfulOrderHistorySync(storeId),
            ),
      ]);

    const storeCurrencyAds = advertising.currencies.find(
      (item) => item.currency === store.currencyCode,
    );
    const sameCurrencyAdSpendAvailable = Boolean(storeCurrencyAds);
    const currentSpend = storeCurrencyAds?.current.spend ?? 0;
    const comparisonSpend = storeCurrencyAds?.comparison.spend ?? 0;
    const currentMer =
      sameCurrencyAdSpendAvailable && currentSpend > 0
        ? commerce.current.netOrderValue / currentSpend
        : null;
    const comparisonMer =
      sameCurrencyAdSpendAvailable && comparisonSpend > 0
        ? commerce.comparison.netOrderValue / comparisonSpend
        : null;

    const currentProfitability = {
      netProductRevenue: profitabilityBase.current.netProductRevenue,
      cogs: profitabilityBase.current.cogs,
      costCoverage: profitabilityBase.current.costCoverage,
      contributionBeforeAds: profitabilityBase.current.contributionBeforeAds,
      adSpend: currentSpend,
      contributionAfterAds:
        !sameCurrencyAdSpendAvailable || profitabilityBase.current.contributionBeforeAds === null
          ? null
          : profitabilityBase.current.contributionBeforeAds - currentSpend,
    };
    const comparisonProfitability = {
      netProductRevenue: profitabilityBase.comparison.netProductRevenue,
      cogs: profitabilityBase.comparison.cogs,
      costCoverage: profitabilityBase.comparison.costCoverage,
      contributionBeforeAds: profitabilityBase.comparison.contributionBeforeAds,
      adSpend: comparisonSpend,
      contributionAfterAds:
        !sameCurrencyAdSpendAvailable || profitabilityBase.comparison.contributionBeforeAds === null
          ? null
          : profitabilityBase.comparison.contributionBeforeAds - comparisonSpend,
    };

    return {
      window: windowResponse(windows),
      currency: store.currencyCode,
      methodology: {
        commerce: 'SHOPIFY_CURRENT_ORDER_VALUE_BY_ORDER_COHORT',
        productEconomics: 'SHOPIFY_PRODUCT_ORDER_COHORT_NET_OF_LINKED_REFUNDS',
        advertising: 'META_PROVIDER_ATTRIBUTION_GROUPED_BY_CURRENCY',
        blendedMer: 'SHOPIFY_CURRENT_ORDER_VALUE_DIVIDED_BY_SAME_CURRENCY_META_SPEND',
        profitLabel: 'CONTRIBUTION_AFTER_ADS_NOT_NET_PROFIT',
      },
      commerce,
      profitability: {
        current: currentProfitability,
        comparison: comparisonProfitability,
        change: metricChanges(currentProfitability, comparisonProfitability),
        sameCurrencyAdSpendAvailable,
        excludedMetaCurrencies: advertising.currencies
          .map((item) => item.currency)
          .filter((currency) => currency !== store.currencyCode),
      },
      advertising: advertising.currencies,
      blended: {
        current: { mer: currentMer, metaSpend: currentSpend },
        comparison: { mer: comparisonMer, metaSpend: comparisonSpend },
        change: {
          mer: percentChange(currentMer, comparisonMer),
          metaSpend: sameCurrencyAdSpendAvailable
            ? percentChange(currentSpend, comparisonSpend)
            : null,
        },
        sameCurrencySpendAvailable: sameCurrencyAdSpendAvailable,
      },
      availability: this.availability(
        store,
        advertising.lastInsightsSyncedAt,
        latestSuccessfulOrderHistory,
      ),
    };
  }

  async products(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.commerce.products(store, windows, query.page, query.limit);
  }

  async product(storeId: string, productId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.commerce.product(store, windows, productId);
  }

  async collections(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    if (this.collectionReadService) {
      return this.collectionReadService.list({
        storeId: store.id,
        currency: store.currencyCode,
        windows,
        page: query.page,
        limit: query.limit,
      });
    }
    return this.commerce.collections(store, windows, query.page, query.limit);
  }

  async customers(storeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.commerce.customers(store, windows);
  }

  async inventory(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.commerce.inventory(store, windows, query.page, query.limit);
  }

  async advertising(storeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.overview(store, windows);
  }

  async campaigns(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.campaigns(store, windows, query.page, query.limit);
  }

  async campaign(storeId: string, campaignId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.campaign(store, windows, campaignId);
  }

  async adSets(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.adSets(store, windows, query.page, query.limit);
  }

  async adSet(storeId: string, adSetId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.adSet(store, windows, adSetId);
  }

  async ads(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.ads(store, windows, query.page, query.limit);
  }

  async ad(storeId: string, adId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.ad(store, windows, adId);
  }

  async creatives(storeId: string, query: AnalyticsListQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.creatives(store, windows, query.page, query.limit);
  }

  async creative(storeId: string, creativeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
    return this.advertisingService.creative(store, windows, creativeId);
  }

  private async context(storeId: string, query: AnalyticsRangeQuery, now: Date) {
    const store = await this.loadStore(storeId);
    return {
      store,
      windows: resolveAnalyticsWindows(query, store.ianaTimezone, now),
    };
  }

  private availability(
    store: StoreContext,
    lastInsightsSyncedAt: Date | null,
    latestSuccessfulOrderHistory: OrderHistorySync | null,
  ) {
    const shopify = store.shopifyConnection;
    const latestOrderHistoryAttempt = shopify?.syncRuns[0] ?? null;
    const successfulOrderHistory =
      latestOrderHistoryAttempt?.status === 'SUCCEEDED'
        ? latestOrderHistoryAttempt
        : latestSuccessfulOrderHistory;
    const fullOrderHistoryAuthorized = Boolean(shopify?.scopes.includes('read_all_orders'));
    const orderHistoryReady = Boolean(successfulOrderHistory);

    return {
      shopify: {
        connected: shopify?.status === 'ACTIVE',
        lastSyncedAt: shopify?.lastSyncedAt ?? null,
        lastStoreSyncedAt: shopify?.lastSyncedAt ?? null,
        fullOrderHistoryAuthorized,
        fullOrderHistory: fullOrderHistoryAuthorized,
        orderHistory: {
          authorization: fullOrderHistoryAuthorized ? 'ALL_ORDERS' : 'RECENT_ORDERS',
          syncReady: orderHistoryReady,
          latestAttemptStatus: latestOrderHistoryAttempt?.status ?? null,
          recordsRead: successfulOrderHistory?.recordsRead ?? 0,
          recordsWritten: successfulOrderHistory?.recordsWritten ?? 0,
          finishedAt: successfulOrderHistory?.finishedAt ?? null,
          fullCoverageVerified: false,
        },
      },
      meta: {
        connected: store.metaConnection?.status === 'ACTIVE',
        selectedAdAccounts: store.metaConnection?.selectedAdAccountIds.length ?? 0,
        lastInsightsSyncedAt,
      },
      inventoryMode: store.inventoryIntelligenceMode,
    };
  }

  private async loadStore(storeId: string): Promise<StoreContext> {
    const store = await memoizeRequestRead(`analytics:store-context:${storeId}`, () =>
      this.repository.getStoreContext(storeId),
    );
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return store;
  }
}

export const analyticsWorkspace = new AnalyticsWorkspace(
  new AnalyticsRepository(),
  new AdvertisingAnalyticsReadRepository(),
  new CommerceAnalyticsReadRepository(),
  collectionAnalyticsReadService,
);
