import { AppError } from '../../errors/app-error.js';
import type { MetaRepository } from './meta.repository.js';
import type { MetaApiService } from './shared/meta-api.service.js';
import type { MetaAuthService } from './shared/meta-auth.service.js';
import { normalizeMetaAdAccountId } from './meta.utils.js';

export class MetaService {
  constructor(
    private readonly repository: MetaRepository,
    private readonly authService: MetaAuthService,
    private readonly apiService: MetaApiService,
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
