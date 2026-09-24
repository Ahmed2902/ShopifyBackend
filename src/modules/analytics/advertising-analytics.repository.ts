import type { AnalyticsRepository } from './analytics.repository.js';

export type AdvertisingMetaFilter = Parameters<AnalyticsRepository['getMetaRows']>[4];

export interface AdvertisingAnalyticsRepository {
  getMetaRows(
    storeId: string,
    selectedAccountIds: string[],
    from: Date,
    to: Date,
    filter?: AdvertisingMetaFilter,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getMetaRows']>>>;

  getCampaignsPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getCampaignsPage']>>>;
  getCampaign(
    storeId: string,
    selectedAccountIds: string[],
    campaignId: string,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getCampaign']>>>;

  getAdSetsPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getAdSetsPage']>>>;
  getAdSet(
    storeId: string,
    selectedAccountIds: string[],
    adSetId: string,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getAdSet']>>>;

  getAdsPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getAdsPage']>>>;
  getAd(
    storeId: string,
    selectedAccountIds: string[],
    adId: string,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getAd']>>>;

  getCreativesPage(
    storeId: string,
    selectedAccountIds: string[],
    page: number,
    limit: number,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getCreativesPage']>>>;
  getCreative(
    storeId: string,
    selectedAccountIds: string[],
    creativeId: string,
  ): PromiseLike<Awaited<ReturnType<AnalyticsRepository['getCreative']>>>;
}
