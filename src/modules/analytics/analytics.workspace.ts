import { AppError } from '../../errors/app-error.js';
import { AdvertisingAnalyticsService } from './advertising-analytics.service.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { metricChanges, percentChange } from './analytics.metrics.js';
import { AnalyticsRepository } from './analytics.repository.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';
import { CommerceAnalyticsService } from './commerce-analytics.service.js';

type StoreContext = NonNullable<Awaited<ReturnType<AnalyticsRepository['getStoreContext']>>>;

/**
 * Page-oriented read side for Stride analytics.
 *
 * Like Systemly's workspace queries, this composes existing domain facts for a page
 * without creating a second data model or moving mutations out of their owning domains.
 */
export class AnalyticsWorkspace {
  private readonly commerce: CommerceAnalyticsService;
  private readonly advertisingService: AdvertisingAnalyticsService;

  constructor(private readonly repository: AnalyticsRepository = new AnalyticsRepository()) {
    this.commerce = new CommerceAnalyticsService(repository);
    this.advertisingService = new AdvertisingAnalyticsService(repository);
  }

  async overview(storeId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const store = await this.loadStore(storeId);
    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const [commerce, advertising, profitabilityBase] = await Promise.all([
      this.commerce.summary(store, windows),
      this.advertisingService.overview(store, windows),
      this.commerce.profitabilityBase(store, windows),
    ]);

    const storeCurrencyAds = advertising.currencies.find(
      (item) => item.currency === store.currencyCode,
    );
    const currentSpend = storeCurrencyAds?.current.spend ?? 0;
    const comparisonSpend = storeCurrencyAds?.comparison.spend ?? 0;
    const currentMer = currentSpend > 0 ? commerce.current.netOrderValue / currentSpend : null;
    const comparisonMer =
      comparisonSpend > 0 ? commerce.comparison.netOrderValue / comparisonSpend : null;

    const currentProfitability = {
      netProductRevenue: profitabilityBase.current.netProductRevenue,
      cogs: profitabilityBase.current.cogs,
      costCoverage: profitabilityBase.current.costCoverage,
      contributionBeforeAds: profitabilityBase.current.contributionBeforeAds,
      adSpend: currentSpend,
      contributionAfterAds:
        profitabilityBase.current.contributionBeforeAds === null
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
        profitabilityBase.comparison.contributionBeforeAds === null
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
          metaSpend: percentChange(currentSpend, comparisonSpend),
        },
      },
      availability: this.availability(store),
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

  private availability(store: StoreContext) {
    return {
      shopify: {
        connected: store.shopifyConnection?.status === 'ACTIVE',
        fullOrderHistory: Boolean(store.shopifyConnection?.scopes.includes('read_all_orders')),
        lastSyncedAt: store.shopifyConnection?.lastSyncedAt ?? null,
      },
      meta: {
        connected: store.metaConnection?.status === 'ACTIVE',
        selectedAdAccounts: store.metaConnection?.selectedAdAccountIds.length ?? 0,
      },
      inventoryMode: store.inventoryIntelligenceMode,
    };
  }

  private async loadStore(storeId: string): Promise<StoreContext> {
    const store = await this.repository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return store;
  }
}

export const analyticsWorkspace = new AnalyticsWorkspace();
