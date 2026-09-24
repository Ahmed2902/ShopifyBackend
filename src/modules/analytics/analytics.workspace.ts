import { AppError } from '../../errors/app-error.js';
import { memoizeRequestRead } from '../../lib/request-read-cache.js';
import { AdvertisingAnalyticsReadRepository } from './advertising-analytics.read.repository.js';
import type { AdvertisingAnalyticsRepository } from './advertising-analytics.repository.js';
import { AdvertisingAnalyticsService } from './advertising-analytics.service.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { metricChanges, percentChange } from './analytics.metrics.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';
import { CanonicalAnalyticsRepository } from './canonical-analytics.repository.js';
import { collectionAnalyticsReadService } from './collection-analytics.read.service.js';
import type { CollectionAnalyticsReadService } from './collection-analytics.read.service.js';
import { CommerceAnalyticsReadRepository } from './commerce-analytics.read.repository.js';
import { CommerceAnalyticsService } from './commerce-analytics.service.js';
import {
  legacyContributionAfterAds,
  legacyMer,
  legacySpendChange,
  resolveLegacyAdvertisingEvidence,
} from './legacy-ad-evidence.js';

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
    advertisingRepository: AdvertisingAnalyticsRepository = repository,
  ) {
    this.commerce = new CommerceAnalyticsService(repository, commerceReadRepository);
    this.advertisingService = new AdvertisingAnalyticsService(
      advertisingRepository,
      advertisingReadRepository,
    );
  }

  async overview(storeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const { store, windows } = await this.context(storeId, query, now);
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

    const adEvidence = resolveLegacyAdvertisingEvidence(
      advertising.currencies,
      store.currencyCode,
    );
    const currentSpend = adEvidence.current.spend;
    const comparisonSpend = adEvidence.comparison.spend;
    const currentMer = legacyMer(commerce.current.netOrderValue, adEvidence.current);
    const comparisonMer = legacyMer(
      commerce.comparison.netOrderValue,
      adEvidence.comparison,
    );
    const bothPeriodsHaveSameCurrencyAdSpendEvidence =
      adEvidence.current.evidenceAvailable && adEvidence.comparison.evidenceAvailable;

    const currentProfitability = {
      netProductRevenue: profitabilityBase.current.netProductRevenue,
      cogs: profitabilityBase.current.cogs,
      costCoverage: profitabilityBase.current.costCoverage,
      contributionBeforeAds: profitabilityBase.current.contributionBeforeAds,
      adSpend: currentSpend,
      contributionAfterAds: legacyContributionAfterAds(
        profitabilityBase.current.contributionBeforeAds,
        adEvidence.current,
      ),
    };
    const comparisonProfitability = {
      netProductRevenue: profitabilityBase.comparison.netProductRevenue,
      cogs: profitabilityBase.comparison.cogs,
      costCoverage: profitabilityBase.comparison.costCoverage,
      contributionBeforeAds: profitabilityBase.comparison.contributionBeforeAds,
      adSpend: comparisonSpend,
      contributionAfterAds: legacyContributionAfterAds(
        profitabilityBase.comparison.contributionBeforeAds,
        adEvidence.comparison,
      ),
    };
    const profitabilityChange = {
      ...metricChanges(currentProfitability, comparisonProfitability),
      adSpend: legacySpendChange(adEvidence.current, adEvidence.comparison),
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
        change: profitabilityChange,
        sameCurrencyAdSpendAvailable: bothPeriodsHaveSameCurrencyAdSpendEvidence,
        sameCurrencyAdSpendAvailability: {
          current: adEvidence.current.evidenceAvailable,
          comparison: adEvidence.comparison.evidenceAvailable,
        },
        excludedMetaCurrencies: advertising.currencies
          .map((item) => item.currency)
          .filter((currency) => currency !== store.currencyCode),
      },
      advertising: advertising.currencies,
      blended: {
        current: {
          mer: currentMer,
          metaSpend: currentSpend,
          evidenceAvailable: adEvidence.current.evidenceAvailable,
        },
        comparison: {
          mer: comparisonMer,
          metaSpend: comparisonSpend,
          evidenceAvailable: adEvidence.comparison.evidenceAvailable,
        },
        change: {
          mer: percentChange(currentMer, comparisonMer),
          metaSpend: legacySpendChange(adEvidence.current, adEvidence.comparison),
        },
        sameCurrencySpendAvailable: bothPeriodsHaveSameCurrencyAdSpendEvidence,
        sameCurrencySpendAvailability: {
          current: adEvidence.current.evidenceAvailable,
          comparison: adEvidence.comparison.evidenceAvailable,
        },
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
    const baseStore = await this.loadStore(storeId);
    const store = this.scopeMetaAccount(baseStore, query.accountId);
    return {
      store,
      windows: resolveAnalyticsWindows(query, store.ianaTimezone, now),
    };
  }

  private scopeMetaAccount(store: StoreContext, accountId?: string): StoreContext {
    if (!accountId) return store;
    const selected = store.metaConnection?.selectedAdAccountIds ?? [];
    if (!store.metaConnection || !selected.includes(accountId)) {
      throw new AppError(
        'Meta ad account is not selected for this store',
        400,
        'META_AD_ACCOUNT_NOT_SELECTED',
      );
    }
    return {
      ...store,
      metaConnection: {
        ...store.metaConnection,
        selectedAdAccountIds: [accountId],
      },
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
  new CanonicalAnalyticsRepository(),
);
