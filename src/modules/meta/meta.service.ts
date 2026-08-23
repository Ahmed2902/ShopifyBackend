import { AppError } from '../../errors/app-error.js';
import type { IntegrationService } from '../integrations/integration.service.js';
import type { MetaAdsRepository } from './ads/meta-ads.repository.js';
import type { MetaAdsService } from './ads/meta-ads.service.js';
import type { MetaRepository } from './meta.repository.js';
import type { MetaApiService } from './shared/meta-api.service.js';
import type { MetaAuthService } from './shared/meta-auth.service.js';
import { normalizeMetaAdAccountId } from './meta.utils.js';

const ADS_HIERARCHY_RESOURCE = 'AdsHierarchy';

function jsonSafe<T>(value: T): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, current) =>
      typeof current === 'bigint' ? current.toString() : current,
    ),
  ) as unknown;
}

export class MetaService {
  constructor(
    private readonly repository: MetaRepository,
    private readonly authService: MetaAuthService,
    private readonly apiService: MetaApiService,
    private readonly adsService: MetaAdsService,
    private readonly adsRepository: MetaAdsRepository,
    private readonly integrationService: IntegrationService,
  ) {}

  startOAuthInstall(userId: string, storeId: string) {
    return this.authService.startInstall(userId, storeId);
  }

  completeOAuthInstall(code: string, state: string) {
    return this.authService.completeInstall(code, state);
  }

  async discoverAssets(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    const [businesses, adAccounts] = await Promise.all([
      context.scopes.includes('business_management')
        ? this.apiService.listBusinesses(context)
        : Promise.resolve([]),
      this.apiService.listAdAccounts(context),
    ]);

    return {
      businesses,
      adAccounts: adAccounts.map((account) => ({
        id: account.id,
        accountId: account.accountId,
        name: account.name,
        accountStatus: account.accountStatus,
        currency: account.currency,
        timezoneName: account.timezoneName,
        timezoneId: account.timezoneId,
        timezoneOffsetHoursUtc: account.timezoneOffsetHoursUtc,
        business: account.business,
      })),
      permissions: {
        granted: context.scopes,
        businessDiscoveryAvailable: context.scopes.includes('business_management'),
      },
    };
  }

  async configureAssets(
    storeId: string,
    input: { metaBusinessId?: string | null; adAccountIds: string[] },
  ) {
    const context = await this.authService.getApiContext(storeId);
    const [businesses, adAccounts] = await Promise.all([
      context.scopes.includes('business_management')
        ? this.apiService.listBusinesses(context)
        : Promise.resolve([]),
      this.apiService.listAdAccounts(context),
    ]);

    const businessId = input.metaBusinessId ?? null;
    if (businessId && !businesses.some((business) => business.id === businessId)) {
      throw new AppError(
        'Selected Meta business is not accessible to this connection',
        400,
        'META_BUSINESS_NOT_ACCESSIBLE',
      );
    }

    const requested = new Set(input.adAccountIds.map(normalizeMetaAdAccountId));
    const selected = adAccounts.filter((account) => requested.has(account.id));
    const discoveredIds = new Set(selected.map((account) => account.id));
    const missing = Array.from(requested).filter((id) => !discoveredIds.has(id));
    if (missing.length > 0) {
      throw new AppError(
        `Selected Meta ad accounts are not accessible: ${missing.join(', ')}`,
        400,
        'META_AD_ACCOUNT_NOT_ACCESSIBLE',
      );
    }

    await this.repository.configureAssets({
      connectionId: context.connectionId,
      storeId,
      metaBusinessId: businessId,
      adAccounts: selected,
    });

    return {
      storeId,
      metaBusinessId: businessId,
      selectedAdAccountIds: selected.map((account) => account.id),
      selectedAdAccounts: selected.map((account) => ({
        id: account.id,
        accountId: account.accountId,
        name: account.name,
        currency: account.currency,
        timezoneName: account.timezoneName,
      })),
    };
  }

  async syncAdsHierarchy(storeId: string) {
    const context = await this.authService.getApiContext(storeId);
    if (context.selectedAdAccountIds.length === 0) {
      throw new AppError(
        'Select at least one Meta ad account before syncing ads',
        409,
        'META_ASSETS_NOT_CONFIGURED',
      );
    }

    const syncRun = await this.integrationService.startSyncRun({
      provider: 'META',
      connectionId: context.connectionId,
      resourceType: ADS_HIERARCHY_RESOURCE,
      mode: 'MANUAL',
      apiVersion: context.apiVersion,
    });

    try {
      const breakdown = {
        adAccounts: 0,
        campaigns: 0,
        adSets: 0,
        creatives: 0,
        ads: 0,
        softDeletedCampaigns: 0,
        softDeletedAdSets: 0,
        softDeletedCreatives: 0,
        softDeletedAds: 0,
      };
      let recordsRead = 0;
      let recordsWritten = 0;

      // Sequential account sync avoids multiplying Marketing API pressure across merchants with many accounts.
      for (const accountId of context.selectedAdAccountIds) {
        const result = await this.adsService.syncSelectedAccount(context, accountId);
        recordsRead += result.recordsRead;
        recordsWritten += result.recordsWritten;
        for (const key of Object.keys(breakdown) as Array<keyof typeof breakdown>) {
          breakdown[key] += result.breakdown[key];
        }
      }

      await this.repository.markConnectionSynced(context.connectionId);
      await this.integrationService.completeSyncRun(syncRun.id, { recordsRead, recordsWritten });
      await this.integrationService.recordExternalPayload({
        provider: 'META',
        resourceType: 'AdsHierarchySyncSummary',
        apiVersion: context.apiVersion,
        payload: { selectedAdAccountIds: context.selectedAdAccountIds, breakdown },
        syncRunId: syncRun.id,
      });

      return {
        syncRunId: syncRun.id,
        status: 'SUCCEEDED' as const,
        resourceType: ADS_HIERARCHY_RESOURCE,
        recordsRead,
        recordsWritten,
        breakdown,
      };
    } catch (error) {
      await this.integrationService.failSyncRun(syncRun.id, error).catch(() => undefined);
      throw error;
    }
  }

  async listAdAccounts(storeId: string) {
    return jsonSafe(await this.adsRepository.listAdAccounts(storeId));
  }

  async listCampaigns(
    storeId: string,
    input: { adAccountId?: string; status?: string; page: number; limit: number },
  ) {
    return jsonSafe(await this.adsRepository.listCampaigns(storeId, input));
  }

  async listAdSets(
    storeId: string,
    input: { campaignId?: string; status?: string; page: number; limit: number },
  ) {
    return jsonSafe(await this.adsRepository.listAdSets(storeId, input));
  }

  async listAds(
    storeId: string,
    input: { campaignId?: string; adSetId?: string; status?: string; page: number; limit: number },
  ) {
    return jsonSafe(await this.adsRepository.listAds(storeId, input));
  }

  async getAd(storeId: string, metaAdId: string) {
    const ad = await this.adsRepository.getAd(storeId, metaAdId);
    if (!ad) throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
    return jsonSafe(ad);
  }

  async getStatus(storeId: string) {
    const connection = await this.repository.getStatus(storeId);
    if (!connection) {
      return {
        connected: false,
        status: 'DISCONNECTED' as const,
        configured: false,
        connection: null,
        adAccounts: [],
      };
    }

    const selected = new Set(connection.selectedAdAccountIds);
    return {
      connected: connection.status === 'ACTIVE',
      status: connection.status,
      configured: connection.selectedAdAccountIds.length > 0,
      connection: {
        id: connection.id,
        metaUserId: connection.metaUserId,
        metaBusinessId: connection.metaBusinessId,
        scopes: connection.scopes,
        apiVersion: connection.apiVersion,
        tokenExpiresAt: connection.tokenExpiresAt,
        lastSyncedAt: connection.lastSyncedAt,
      },
      adAccounts: connection.adAccounts.filter((account) => selected.has(account.metaAccountId)),
    };
  }
}
