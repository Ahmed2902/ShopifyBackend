import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { advertisingWriteRepository } from '../advertising/advertising-write.repository.js';
import {
  bulkUpsertGoogleAds,
  type GoogleAdsBulkAdInput,
  type GoogleAdsBulkCreativeInput,
  type GoogleAdsBulkMetricInput,
} from './google-ads-postgres-bulk-upsert.js';
import type { GoogleAdsRepository } from './google-ads.repository.js';
import type {
  GoogleAdsDiscoveredCustomer,
  GoogleAdsObject,
  GoogleAdsSyncStats,
} from './google-ads.types.js';
import {
  deterministicUuid,
  googleDate,
  microsToDecimal,
  normalizeCustomerId,
  numberValue,
  stringValue,
} from './google-ads.utils.js';
import type { GoogleAdsApiService } from './shared/google-ads-api.service.js';
import type { GoogleAdsAuthService } from './shared/google-ads-auth.service.js';

const HIERARCHY_LIMIT = 500;
const METRIC_CHUNK_DAYS = 30;
const INITIAL_LOOKBACK_DAYS = 365;
const REFRESH_LOOKBACK_DAYS = 35;

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value && typeof value === 'object' ? (value as Obj) : {});
const nested = (row: GoogleAdsObject, key: string) => obj(row[key]);
const str = (row: Obj, key: string) => stringValue(row[key]);
const bool = (row: Obj, key: string) => (typeof row[key] === 'boolean' ? (row[key] as boolean) : false);
const decimalMicros = (value: unknown) => microsToDecimal(value);

function toGoogleErrorCode(error: unknown) {
  return error instanceof AppError ? error.code : 'GOOGLE_ADS_SYNC_FAILED';
}

function ymd(date: Date) {
  return date.toISOString().slice(0, 10);
}

function dateChunks(lookbackDays: number) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const first = new Date(today);
  first.setUTCDate(first.getUTCDate() - Math.max(lookbackDays - 1, 0));
  const chunks: Array<{ from: string; to: string }> = [];
  for (let cursor = new Date(first); cursor <= today; ) {
    const end = new Date(cursor);
    end.setUTCDate(end.getUTCDate() + METRIC_CHUNK_DAYS - 1);
    if (end > today) end.setTime(today.getTime());
    chunks.push({ from: ymd(cursor), to: ymd(end) });
    cursor = new Date(end);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function metricValue(metrics: Obj, key: string) {
  const value = metrics[key];
  return value === undefined || value === null ? null : String(value);
}

function checkpointKey(kind: string, from: Date, to: Date) {
  return `${kind}:${ymd(from)}:${ymd(to)}`;
}

export class GoogleAdsService {
  constructor(
    private readonly repository: GoogleAdsRepository,
    private readonly auth: GoogleAdsAuthService,
    private readonly api: GoogleAdsApiService,
  ) {}

  startOAuthInstall(userId: string, storeId: string) {
    return this.auth.startInstall(userId, storeId);
  }

  completeOAuthInstall(code: string, state: string) {
    return this.auth.completeInstall(code, state);
  }

  async getStatus(storeId: string) {
    const connection = await this.repository.findConnectionForStore(storeId);
    if (!connection) return null;
    return {
      id: connection.id,
      status: connection.status,
      selectedCustomerIds: connection.selectedCustomerIds,
      scopes: connection.scopes,
      apiVersion: connection.apiVersion,
      lastSyncedAt: connection.lastSyncedAt,
      lastSyncStatus: connection.lastSyncStatus,
      lastSyncError: connection.lastSyncError,
    };
  }

  async disconnect(storeId: string) {
    const connection = await this.repository.findConnectionForStore(storeId);
    if (!connection) return null;
    await this.repository.disconnect(storeId);
    return this.getStatus(storeId);
  }

  async discoverCustomers(storeId: string) {
    const context = await this.auth.getApiContext(storeId);
    const direct = await this.api.listAccessibleCustomers(context.accessToken, context.apiVersion);
    const discovered = new Map<string, GoogleAdsDiscoveredCustomer>();
    const queued = direct.map((customerId) => ({
      customerId,
      loginCustomerId: null as string | null,
      parentCustomerId: null as string | null,
      level: 0,
    }));
    const traversedManagers = new Set<string>();

    while (queued.length > 0) {
      if (discovered.size + queued.length > HIERARCHY_LIMIT) {
        throw new AppError(
          'Google Ads account hierarchy exceeds the supported discovery bound',
          409,
          'GOOGLE_ADS_HIERARCHY_TOO_LARGE',
        );
      }
      const current = queued.shift()!;
      let rows: GoogleAdsObject[];
      try {
        rows = await this.api.search({
          accessToken: context.accessToken,
          apiVersion: context.apiVersion,
          customerId: current.customerId,
          loginCustomerId: current.loginCustomerId,
          query:
            'SELECT customer_client.id, customer_client.client_customer, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.test_account, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level <= 1',
        });
      } catch (error) {
        rows = await this.api
          .search({
            accessToken: context.accessToken,
            apiVersion: context.apiVersion,
            customerId: current.customerId,
            loginCustomerId: current.loginCustomerId,
            query:
              'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.status FROM customer LIMIT 1',
          })
          .catch(() => {
            throw error;
          });
      }

      for (const row of rows) {
        const client = nested(row, 'customerClient');
        const customer = nested(row, 'customer');
        const source = Object.keys(client).length > 0 ? client : customer;
        const rawId =
          str(source, 'id') ??
          str(source, 'clientCustomer')?.split('/').pop() ??
          current.customerId;
        const customerId = normalizeCustomerId(rawId);
        const manager = bool(source, 'manager');
        const localLevel = numberValue(source.level) ?? current.level;
        const loginCustomerId =
          current.loginCustomerId ??
          (direct.includes(current.customerId) && manager ? current.customerId : null);
        const item: GoogleAdsDiscoveredCustomer = {
          customerId,
          loginCustomerId,
          descriptiveName: str(source, 'descriptiveName') ?? customerId,
          status: str(source, 'status'),
          currencyCode: str(source, 'currencyCode'),
          timeZone: str(source, 'timeZone'),
          manager,
          testAccount: bool(source, 'testAccount'),
          level: localLevel,
          parentCustomerId: customerId === current.customerId ? current.parentCustomerId : current.customerId,
          raw: row,
        };
        const previous = discovered.get(customerId);
        if (!previous || (previous.loginCustomerId === null && item.loginCustomerId !== null)) {
          discovered.set(customerId, item);
        }
        if (manager && customerId !== current.customerId && !traversedManagers.has(customerId)) {
          traversedManagers.add(customerId);
          queued.push({
            customerId,
            loginCustomerId: loginCustomerId ?? current.customerId,
            parentCustomerId: current.customerId,
            level: (localLevel ?? current.level) + 1,
          });
        }
      }
    }

    for (const customerId of direct) {
      if (!discovered.has(customerId)) {
        discovered.set(customerId, {
          customerId,
          loginCustomerId: null,
          descriptiveName: customerId,
          status: null,
          currencyCode: null,
          timeZone: null,
          manager: false,
          testAccount: false,
          level: 0,
          parentCustomerId: null,
          raw: { customerId },
        });
      }
    }
    for (const customer of discovered.values()) {
      await this.repository.upsertDiscoveredCustomer({
        storeId,
        connectionId: context.connectionId,
        ...customer,
      });
    }
    await this.repository.pruneDiscoveredCustomers(
      storeId,
      context.connectionId,
      [...discovered.keys()],
    );
    return {
      customers: [...discovered.values()].map(({ raw: _raw, ...customer }) => customer),
      permissions: { granted: context.scopes },
    };
  }

  async configureCustomers(storeId: string, requestedIds: string[]) {
    const context = await this.auth.getApiContext(storeId);
    const normalized = [...new Set(requestedIds.map(normalizeCustomerId))];
    if (normalized.length === 0) {
      throw new AppError(
        'Select at least one Google Ads customer',
        400,
        'GOOGLE_ADS_CUSTOMERS_NOT_CONFIGURED',
      );
    }
    const discovery = await this.discoverCustomers(storeId);
    const currentCustomers = new Map(
      discovery.customers.map((customer) => [customer.customerId, customer] as const),
    );
    const missing = normalized.filter((id) => !currentCustomers.has(id));
    if (missing.length > 0) {
      throw new AppError(
        'Selected Google Ads customer is not accessible',
        400,
        'GOOGLE_ADS_CUSTOMER_NOT_ACCESSIBLE',
        { customerIds: missing },
      );
    }
    if (normalized.some((id) => currentCustomers.get(id)?.manager)) {
      throw new AppError(
        'Select client advertising accounts, not manager accounts',
        400,
        'GOOGLE_ADS_MANAGER_NOT_SELECTABLE',
      );
    }
    await this.repository.configureCustomers(context.connectionId, normalized);
    return this.getStatus(storeId);
  }

  async sync(
    storeId: string,
    mode: 'HISTORICAL' | 'INCREMENTAL' = 'INCREMENTAL',
  ): Promise<GoogleAdsSyncStats> {
    const context = await this.auth.getApiContext(storeId);
    if (context.selectedCustomerIds.length === 0) {
      throw new AppError(
        'Select at least one Google Ads customer first',
        409,
        'GOOGLE_ADS_CUSTOMERS_NOT_CONFIGURED',
      );
    }
    const customers = await this.repository.findSelectedCustomers(
      storeId,
      context.selectedCustomerIds,
    );
    if (customers.length !== context.selectedCustomerIds.length) {
      throw new AppError(
        'A selected Google Ads customer is no longer accessible in Stride',
        409,
        'GOOGLE_ADS_CUSTOMER_NOT_ACCESSIBLE',
      );
    }
    const stats: GoogleAdsSyncStats = {
      recordsRead: 0,
      recordsWritten: 0,
      partial: false,
      failures: [],
    };
    for (const customer of customers) {
      try {
        const hierarchy = await this.syncHierarchy(context, customer);
        stats.recordsRead += hierarchy.read;
        stats.recordsWritten += hierarchy.written;
        const metrics = await this.syncMetrics(
          context,
          customer,
          mode === 'HISTORICAL' ? INITIAL_LOOKBACK_DAYS : REFRESH_LOOKBACK_DAYS,
          mode === 'HISTORICAL',
        );
        stats.recordsRead += metrics.read;
        stats.recordsWritten += metrics.written;
      } catch (error) {
        if (error instanceof AppError && error.code === 'GOOGLE_ADS_REAUTH_REQUIRED') {
          await this.repository.markReauthRequired(context.connectionId);
          await this.repository.markSyncResult(context.connectionId, {
            status: 'FAILED',
            error: error.code,
          });
          throw error;
        }
        stats.partial = true;
        stats.failures.push({
          customerId: customer.customerId,
          stage: 'SYNC',
          code: toGoogleErrorCode(error),
        });
      }
    }
    const status = stats.partial
      ? stats.recordsWritten > 0
        ? 'PARTIAL'
        : 'FAILED'
      : 'SUCCEEDED';
    await this.repository.markSyncResult(context.connectionId, {
      status,
      error: stats.failures.map((failure) => `${failure.customerId}:${failure.code}`).join(', ') || null,
    });
    if (mode === 'HISTORICAL' && status === 'SUCCEEDED') {
      await this.repository.clearSyncCheckpoints(context.connectionId);
    }
    if (status === 'FAILED') {
      throw new AppError(
        'Google Ads sync failed for all selected customers',
        502,
        'GOOGLE_ADS_SYNC_FAILED',
        { failures: stats.failures },
      );
    }
    return stats;
  }

  private async syncHierarchy(
    context: Awaited<ReturnType<GoogleAdsAuthService['getApiContext']>>,
    customer: Awaited<ReturnType<GoogleAdsRepository['findSelectedCustomers']>>[number],
  ) {
    const common = {
      accessToken: context.accessToken,
      apiVersion: context.apiVersion,
      customerId: customer.customerId,
      loginCustomerId: customer.loginCustomerId,
    };
    const [campaignRows, adGroupRows, assetGroupRows, adRows, assetRows] = await Promise.all([
      this.api.search({
        ...common,
        query:
          'SELECT campaign.id, campaign.name, campaign.status, campaign.serving_status, campaign.advertising_channel_type, campaign.advertising_channel_sub_type, campaign.bidding_strategy_type, campaign.start_date, campaign.end_date, campaign_budget.amount_micros, campaign_budget.period FROM campaign',
      }),
      this.api.search({
        ...common,
        query:
          'SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.primary_status, ad_group.type, ad_group.cpc_bid_micros, ad_group.cpm_bid_micros, ad_group.target_cpa_micros, ad_group.target_roas FROM ad_group',
      }),
      this.api.search({
        ...common,
        query:
          'SELECT campaign.id, asset_group.id, asset_group.name, asset_group.status, asset_group.primary_status, asset_group.final_urls, asset_group.mobile_urls FROM asset_group',
      }),
      this.api.search({
        ...common,
        query:
          'SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, ad_group_ad.ad.name, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group_ad.primary_status FROM ad_group_ad',
      }),
      this.api.search({
        ...common,
        query:
          'SELECT campaign.id, asset_group.id, asset_group_asset.asset, asset_group_asset.field_type, asset_group_asset.status, asset_group_asset.performance_label, asset.id, asset.name, asset.type, asset.text_asset.text, asset.image_asset.full_size.url, asset.youtube_video_asset.youtube_video_id FROM asset_group_asset',
      }),
    ]);
    const campaignIds = new Set<string>();
    const groupIds = new Set<string>();
    const adIds = new Set<string>();
    const creativeIds = new Set<string>();
    let written = 0;
    await prisma.$transaction(
      async (tx) => {
        for (const row of campaignRows) {
          const item = nested(row, 'campaign');
          const externalId = str(item, 'id');
          if (!externalId) continue;
          const id = deterministicUuid('GOOGLE_ADS', customer.customerId, 'CAMPAIGN', externalId);
          campaignIds.add(id);
          const budget = nested(row, 'campaignBudget');
          await advertisingWriteRepository.upsertCampaign(tx, {
            id,
            accountId: customer.id,
            providerEntityId: externalId,
            name: str(item, 'name') ?? externalId,
            status: str(item, 'status'),
            effectiveStatus: str(item, 'servingStatus'),
            campaignType: str(item, 'advertisingChannelType'),
            objective: str(item, 'advertisingChannelSubType'),
            bidStrategy: str(item, 'biddingStrategyType'),
            budgetAmount: decimalMicros(budget.amountMicros),
            budgetMode: str(budget, 'period'),
            startsAt: googleDate(item.startDate),
            endsAt: googleDate(item.endDate),
            providerData: { advertisingChannelSubType: item.advertisingChannelSubType },
            rawJson: row,
            deletedAt: str(item, 'status') === 'REMOVED' ? new Date() : null,
          });
          written += 1;
        }
        for (const row of adGroupRows) {
          const item = nested(row, 'adGroup');
          const campaign = nested(row, 'campaign');
          const externalId = str(item, 'id');
          const campaignExternalId = str(campaign, 'id');
          if (!externalId || !campaignExternalId) continue;
          const campaignId = deterministicUuid(
            'GOOGLE_ADS',
            customer.customerId,
            'CAMPAIGN',
            campaignExternalId,
          );
          const id = deterministicUuid(
            'GOOGLE_ADS',
            customer.customerId,
            'GROUP',
            'AD_GROUP',
            externalId,
          );
          groupIds.add(id);
          await advertisingWriteRepository.upsertGroup(tx, {
            id,
            accountId: customer.id,
            campaignId,
            providerEntityId: externalId,
            kind: 'AD_GROUP',
            name: str(item, 'name') ?? externalId,
            status: str(item, 'status'),
            effectiveStatus: str(item, 'primaryStatus'),
            bidStrategy: str(item, 'type'),
            bidAmount: decimalMicros(
              item.cpcBidMicros ?? item.cpmBidMicros ?? item.targetCpaMicros,
            ),
            providerData: { targetRoas: item.targetRoas },
            rawJson: row,
            deletedAt: str(item, 'status') === 'REMOVED' ? new Date() : null,
          });
          written += 1;
        }
        for (const row of assetGroupRows) {
          const item = nested(row, 'assetGroup');
          const campaign = nested(row, 'campaign');
          const externalId = str(item, 'id');
          const campaignExternalId = str(campaign, 'id');
          if (!externalId || !campaignExternalId) continue;
          const campaignId = deterministicUuid(
            'GOOGLE_ADS',
            customer.customerId,
            'CAMPAIGN',
            campaignExternalId,
          );
          const id = deterministicUuid(
            'GOOGLE_ADS',
            customer.customerId,
            'GROUP',
            'ASSET_GROUP',
            externalId,
          );
          groupIds.add(id);
          await advertisingWriteRepository.upsertGroup(tx, {
            id,
            accountId: customer.id,
            campaignId,
            providerEntityId: externalId,
            kind: 'ASSET_GROUP',
            name: str(item, 'name') ?? externalId,
            status: str(item, 'status'),
            effectiveStatus: str(item, 'primaryStatus'),
            providerData: {
              finalUrls: item.finalUrls,
              mobileUrls: item.mobileUrls,
              googleStructure: 'PERFORMANCE_MAX_ASSET_GROUP',
            },
            rawJson: row,
            deletedAt: str(item, 'status') === 'REMOVED' ? new Date() : null,
          });
          written += 1;
        }

        const ads: GoogleAdsBulkAdInput[] = [];
        for (const row of adRows) {
          const item = nested(nested(row, 'adGroupAd'), 'ad');
          const wrapper = nested(row, 'adGroupAd');
          const campaign = nested(row, 'campaign');
          const group = nested(row, 'adGroup');
          const externalId = str(item, 'id');
          const campaignExternalId = str(campaign, 'id');
          const groupExternalId = str(group, 'id');
          if (!externalId || !campaignExternalId || !groupExternalId) continue;
          const id = deterministicUuid('GOOGLE_ADS', customer.customerId, 'AD', externalId);
          adIds.add(id);
          const finalUrls = Array.isArray(item.finalUrls)
            ? item.finalUrls.filter((value): value is string => typeof value === 'string')
            : [];
          ads.push({
            id,
            accountId: customer.id,
            campaignId: deterministicUuid(
              'GOOGLE_ADS',
              customer.customerId,
              'CAMPAIGN',
              campaignExternalId,
            ),
            groupId: deterministicUuid(
              'GOOGLE_ADS',
              customer.customerId,
              'GROUP',
              'AD_GROUP',
              groupExternalId,
            ),
            providerEntityId: externalId,
            name: str(item, 'name') ?? `${str(item, 'type') ?? 'Google ad'} ${externalId}`,
            status: str(wrapper, 'status'),
            effectiveStatus: str(wrapper, 'primaryStatus'),
            format: str(item, 'type'),
            landingPageUrl: finalUrls[0] ?? null,
            providerData: { finalUrls },
            rawJson: row,
            deletedAt: str(wrapper, 'status') === 'REMOVED' ? new Date() : null,
          });
        }
        await bulkUpsertGoogleAds(tx, { ads });
        written += ads.length;

        const assets = new Map<
          string,
          {
            row: GoogleAdsObject;
            groups: Array<{
              campaignId: string;
              assetGroupId: string;
              fieldType: string | null;
              status: string | null;
              performanceLabel: string | null;
            }>;
          }
        >();
        for (const row of assetRows) {
          const asset = nested(row, 'asset');
          const link = nested(row, 'assetGroupAsset');
          const assetId = str(asset, 'id') ?? str(link, 'asset')?.split('/').pop();
          const assetGroupId = str(nested(row, 'assetGroup'), 'id');
          const campaignId = str(nested(row, 'campaign'), 'id');
          if (!assetId || !assetGroupId || !campaignId) continue;
          const existing = assets.get(assetId) ?? { row, groups: [] };
          existing.groups.push({
            campaignId,
            assetGroupId,
            fieldType: str(link, 'fieldType'),
            status: str(link, 'status'),
            performanceLabel: str(link, 'performanceLabel'),
          });
          assets.set(assetId, existing);
        }
        const creatives: GoogleAdsBulkCreativeInput[] = [];
        for (const [externalId, value] of assets) {
          const asset = nested(value.row, 'asset');
          const id = deterministicUuid('GOOGLE_ADS', customer.customerId, 'ASSET', externalId);
          creativeIds.add(id);
          creatives.push({
            id,
            accountId: customer.id,
            providerEntityId: externalId,
            name: str(asset, 'name'),
            title: str(nested(asset, 'textAsset'), 'text'),
            imageUrl: str(nested(nested(asset, 'imageAsset'), 'fullSize'), 'url'),
            videoId: str(nested(asset, 'youtubeVideoAsset'), 'youtubeVideoId'),
            providerData: { assetType: asset.type, assetGroupLinks: value.groups },
            rawJson: value.row,
            deletedAt: value.groups.every((link) => link.status === 'REMOVED') ? new Date() : null,
          });
        }
        await bulkUpsertGoogleAds(tx, { creatives });
        written += creatives.length;

        await tx.advertisingCampaign.updateMany({
          where: { accountId: customer.id, id: { notIn: [...campaignIds] }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await tx.advertisingGroup.updateMany({
          where: { accountId: customer.id, id: { notIn: [...groupIds] }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await tx.advertisingAd.updateMany({
          where: { accountId: customer.id, id: { notIn: [...adIds] }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
        await tx.advertisingCreative.updateMany({
          where: { accountId: customer.id, id: { notIn: [...creativeIds] }, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      },
      { timeout: 30_000 },
    );
    return {
      read:
        campaignRows.length +
        adGroupRows.length +
        assetGroupRows.length +
        adRows.length +
        assetRows.length,
      written,
    };
  }

  private async syncMetrics(
    context: Awaited<ReturnType<GoogleAdsAuthService['getApiContext']>>,
    customer: Awaited<ReturnType<GoogleAdsRepository['findSelectedCustomers']>>[number],
    lookbackDays: number,
    resumable: boolean,
  ) {
    const common = {
      accessToken: context.accessToken,
      apiVersion: context.apiVersion,
      customerId: customer.customerId,
      loginCustomerId: customer.loginCustomerId,
    };
    const completed = new Set<string>();
    if (resumable) {
      const checkpoints = await this.repository.listSyncCheckpoints(
        context.connectionId,
        customer.customerId,
      );
      for (const checkpoint of checkpoints) {
        completed.add(
          checkpointKey(checkpoint.kind, checkpoint.windowStart, checkpoint.windowEnd),
        );
      }
    }
    let read = 0;
    let written = 0;
    for (const chunk of dateChunks(lookbackDays)) {
      const queries = [
        {
          level: 'ACCOUNT' as const,
          q: `SELECT customer.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion, metrics.conversions_value_per_cost, metrics.all_conversions, metrics.all_conversions_value FROM customer WHERE segments.date BETWEEN '${chunk.from}' AND '${chunk.to}'`,
        },
        {
          level: 'CAMPAIGN' as const,
          q: `SELECT campaign.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion, metrics.conversions_value_per_cost, metrics.all_conversions, metrics.all_conversions_value FROM campaign WHERE segments.date BETWEEN '${chunk.from}' AND '${chunk.to}'`,
        },
        {
          level: 'GROUP' as const,
          q: `SELECT campaign.id, ad_group.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion, metrics.conversions_value_per_cost FROM ad_group WHERE segments.date BETWEEN '${chunk.from}' AND '${chunk.to}'`,
        },
        {
          level: 'ASSET_GROUP' as const,
          q: `SELECT campaign.id, asset_group.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion, metrics.conversions_value_per_cost FROM asset_group WHERE segments.date BETWEEN '${chunk.from}' AND '${chunk.to}'`,
        },
        {
          level: 'AD' as const,
          q: `SELECT campaign.id, ad_group.id, ad_group_ad.ad.id, segments.date, metrics.cost_micros, metrics.impressions, metrics.clicks, metrics.ctr, metrics.average_cpc, metrics.average_cpm, metrics.conversions, metrics.conversions_value, metrics.cost_per_conversion, metrics.conversions_value_per_cost FROM ad_group_ad WHERE segments.date BETWEEN '${chunk.from}' AND '${chunk.to}'`,
        },
      ];
      const windowStart = googleDate(chunk.from)!;
      const windowEnd = googleDate(chunk.to)!;
      for (const query of queries) {
        const kind = `METRICS_${query.level}`;
        const key = checkpointKey(kind, windowStart, windowEnd);
        if (resumable && completed.has(key)) continue;

        const rows = await this.api.search({ ...common, query: query.q });
        read += rows.length;
        const metricsToWrite: GoogleAdsBulkMetricInput[] = [];
        for (const row of rows) {
          const metrics = nested(row, 'metrics');
          const segments = nested(row, 'segments');
          const date = googleDate(segments.date);
          if (!date) continue;
          const campaignExternalId = str(nested(row, 'campaign'), 'id');
          const adGroupExternalId = str(nested(row, 'adGroup'), 'id');
          const assetGroupExternalId = str(nested(row, 'assetGroup'), 'id');
          const adExternalId = str(nested(nested(row, 'adGroupAd'), 'ad'), 'id');
          const campaignId = campaignExternalId
            ? deterministicUuid(
                'GOOGLE_ADS',
                customer.customerId,
                'CAMPAIGN',
                campaignExternalId,
              )
            : null;
          const groupExternalId =
            query.level === 'ASSET_GROUP' ? assetGroupExternalId : adGroupExternalId;
          const groupId = groupExternalId
            ? deterministicUuid(
                'GOOGLE_ADS',
                customer.customerId,
                'GROUP',
                query.level === 'ASSET_GROUP' ? 'ASSET_GROUP' : 'AD_GROUP',
                groupExternalId,
              )
            : null;
          const adId = adExternalId
            ? deterministicUuid('GOOGLE_ADS', customer.customerId, 'AD', adExternalId)
            : null;
          const metricKey = [
            'GOOGLE_ADS',
            customer.customerId,
            query.level,
            ymd(date),
            campaignExternalId ?? '',
            groupExternalId ?? '',
            adExternalId ?? '',
          ].join(':');
          metricsToWrite.push({
            id: deterministicUuid('GOOGLE_ADS_METRIC', metricKey),
            metricKey,
            accountId: customer.id,
            campaignId,
            groupId,
            adId,
            level: query.level,
            date,
            currency: customer.currencyCode,
            spend: microsToDecimal(metrics.costMicros) ?? '0',
            impressions: metricValue(metrics, 'impressions') ?? '0',
            clicks: metricValue(metrics, 'clicks') ?? '0',
            conversions: metricValue(metrics, 'conversions'),
            conversionValue: metricValue(metrics, 'conversionsValue'),
            ctr: metricValue(metrics, 'ctr'),
            cpc: microsToDecimal(metrics.averageCpc),
            cpm: microsToDecimal(metrics.averageCpm),
            cpa: microsToDecimal(metrics.costPerConversion),
            roas: metricValue(metrics, 'conversionsValuePerCost'),
            providerMetrics: {
              allConversions: metrics.allConversions ?? null,
              allConversionsValue: metrics.allConversionsValue ?? null,
              attribution: 'GOOGLE_PROVIDER_REPORTED',
              primaryConversions: 'metrics.conversions',
              reach: 'UNAVAILABLE_NON_ADDITIVE',
            },
            rawJson: row,
          });
        }
        await prisma.$transaction(
          async (tx) => {
            await bulkUpsertGoogleAds(tx, { metrics: metricsToWrite });
          },
          { timeout: 30_000 },
        );
        written += metricsToWrite.length;
        if (resumable) {
          await this.repository.markSyncCheckpoint({
            connectionId: context.connectionId,
            customerId: customer.customerId,
            kind,
            windowStart,
            windowEnd,
          });
          completed.add(key);
        }
      }
    }
    return { read, written };
  }
}
