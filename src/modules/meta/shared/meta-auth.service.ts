import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { invalidateStoreDecisionCaches } from '../../../lib/store-decision-cache.js';
import { decryptSecret, encryptSecret } from '../../integrations/integration.utils.js';
import type { MetaRepository } from '../meta.repository.js';
import type { MetaApiContext } from '../meta.types.js';
import { buildMetaAuthorizationUrl, verifyMetaOAuthState } from '../meta.utils.js';
import type { MetaApiService } from './meta-api.service.js';

const TOKEN_EXPIRY_SKEW_MS = 5 * 60_000;

export interface MetaConnectionContext extends MetaApiContext {
  scopes: string[];
  metaBusinessId: string | null;
  selectedAdAccountIds: string[];
  selectedCatalogIds: string[];
}

export class MetaAuthService {
  constructor(
    private readonly repository: MetaRepository,
    private readonly apiService: MetaApiService,
  ) {}

  async startInstall(userId: string, storeId: string) {
    await this.assertCanManageStore(userId, storeId);
    return buildMetaAuthorizationUrl(userId, storeId);
  }

  async startAdsManagementUpgrade(userId: string, storeId: string) {
    await this.assertCanManageStore(userId, storeId);
    return buildMetaAuthorizationUrl(userId, storeId, 'ADS_MANAGEMENT');
  }

  async completeInstall(code: string, state: string) {
    const context = verifyMetaOAuthState(state);
    await this.assertCanManageStore(context.userId, context.storeId);

    const exchanged = await this.apiService.exchangeAuthorizationCode(code);
    const inspection = await this.apiService.inspectAccessToken(exchanged.accessToken);
    if (!inspection.isValid || inspection.appId !== env.META_APP_ID) {
      throw new AppError('Meta returned an invalid access token', 401, 'INVALID_META_ACCESS_TOKEN');
    }
    this.assertBasePermissions(inspection.scopes);
    if (
      context.authorizationMode === 'ADS_MANAGEMENT' &&
      !inspection.scopes.includes('ads_management')
    ) {
      // Do not persist a downgraded token as a successful upgrade. The existing read-only
      // connection remains untouched and the merchant can retry or choose manual tracking.
      throw new AppError(
        'Meta did not grant the requested ads_management permission',
        403,
        'META_ADS_MANAGEMENT_REQUIRED',
      );
    }

    const expiresAt =
      inspection.expiresAt ??
      (exchanged.expiresInSeconds
        ? new Date(Date.now() + exchanged.expiresInSeconds * 1000)
        : null);

    const connection = await this.repository.upsertConnection({
      storeId: context.storeId,
      metaUserId: inspection.userId,
      accessTokenCiphertext: encryptSecret(exchanged.accessToken),
      tokenExpiresAt: expiresAt,
      scopes: inspection.scopes,
      apiVersion: env.META_API_VERSION,
    });

    await invalidateStoreDecisionCaches(context.storeId);
    return {
      storeId: connection.storeId,
      connectionId: connection.id,
      metaUserId: inspection.userId,
      scopes: inspection.scopes,
      tokenExpiresAt: expiresAt,
    };
  }

  async getApiContext(storeId: string): Promise<MetaConnectionContext> {
    const connection = await this.repository.findConnectionForStore(storeId);
    if (!connection) {
      throw new AppError('Meta is not connected for this store', 409, 'META_NOT_CONNECTED');
    }
    if (connection.status !== 'ACTIVE') {
      throw new AppError(
        'Meta connection requires merchant attention',
        409,
        'META_CONNECTION_INACTIVE',
      );
    }
    try {
      this.assertBasePermissions(connection.scopes);
    } catch (error) {
      await this.repository.markConnectionReauthRequired(connection.id);
      await invalidateStoreDecisionCaches(storeId);
      throw error;
    }

    if (
      connection.tokenExpiresAt &&
      connection.tokenExpiresAt.getTime() <= Date.now() + TOKEN_EXPIRY_SKEW_MS
    ) {
      await this.repository.markConnectionReauthRequired(connection.id);
      await invalidateStoreDecisionCaches(storeId);
      throw new AppError('Meta access token requires reauthorization', 401, 'META_REAUTH_REQUIRED');
    }

    return {
      storeId,
      connectionId: connection.id,
      accessToken: decryptSecret(connection.accessTokenCiphertext),
      apiVersion: connection.apiVersion,
      scopes: connection.scopes,
      metaBusinessId: connection.metaBusinessId,
      selectedAdAccountIds: connection.selectedAdAccountIds,
      selectedCatalogIds: connection.selectedCatalogIds,
    };
  }

  private assertBasePermissions(scopes: string[]): void {
    if (!scopes.includes('ads_read')) {
      throw new AppError(
        'Meta did not grant the required ads_read permission',
        403,
        'META_ADS_READ_REQUIRED',
      );
    }
  }

  private async assertCanManageStore(userId: string, storeId: string): Promise<void> {
    const membership = await this.repository.findMembership(userId, storeId);
    if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
      throw new AppError('Insufficient store role', 403, 'FORBIDDEN');
    }
  }
}
