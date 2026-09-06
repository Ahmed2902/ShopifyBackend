import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { decryptSecret, encryptSecret } from '../../integrations/integration.utils.js';
import { requireTikTokAppCredentials } from '../tiktok.config.js';
import type { TikTokRepository } from '../tiktok.repository.js';
import type { TikTokApiContext } from '../tiktok.types.js';
import {
  buildTikTokAuthorizationUrl,
  configuredTikTokScopes,
  verifyTikTokOAuthState,
} from '../tiktok.utils.js';
import type { TikTokApiService } from './tiktok-api.service.js';

export class TikTokAuthService {
  constructor(
    private readonly repository: TikTokRepository,
    private readonly apiService: TikTokApiService,
  ) {}

  async startInstall(userId: string, storeId: string) {
    await this.assertCanManageStore(userId, storeId);
    return buildTikTokAuthorizationUrl(userId, storeId);
  }

  async completeInstall(authCode: string, state: string) {
    requireTikTokAppCredentials();
    const oauth = verifyTikTokOAuthState(state);
    await this.assertCanManageStore(oauth.userId, oauth.storeId);

    const exchanged = await this.apiService.exchangeAuthorizationCode(authCode);
    const authorized = await this.apiService.listAuthorizedAdvertisers(exchanged.accessToken);
    if (authorized.length === 0 && exchanged.advertiserIds.length === 0) {
      throw new AppError(
        'TikTok did not grant access to any advertiser accounts',
        403,
        'TIKTOK_ADVERTISER_ACCESS_REQUIRED',
      );
    }

    const scopes = exchanged.scopes.length > 0 ? exchanged.scopes : configuredTikTokScopes();
    const connection = await this.repository.upsertConnection({
      storeId: oauth.storeId,
      accessTokenCiphertext: encryptSecret(exchanged.accessToken),
      scopes,
      apiVersion: env.TIKTOK_API_VERSION,
    });

    return {
      storeId: connection.storeId,
      connectionId: connection.id,
      scopes,
      advertiserIds: authorized.map((item) => item.advertiser_id),
    };
  }

  async getApiContext(storeId: string): Promise<TikTokApiContext> {
    requireTikTokAppCredentials();
    const connection = await this.repository.findConnectionForStore(storeId);
    if (!connection) throw new AppError('TikTok is not connected for this store', 409, 'TIKTOK_NOT_CONNECTED');
    if (connection.status !== 'ACTIVE') {
      throw new AppError('TikTok connection requires merchant attention', 409, 'TIKTOK_CONNECTION_INACTIVE');
    }

    if (connection.accessTokenExpiresAt && connection.accessTokenExpiresAt.getTime() <= Date.now()) {
      await this.repository.markConnectionReauthRequired(connection.id);
      throw new AppError('TikTok access token requires reauthorization', 401, 'TIKTOK_REAUTH_REQUIRED');
    }

    return {
      connectionId: connection.id,
      storeId,
      status: connection.status,
      accessToken: decryptSecret(connection.accessTokenCiphertext),
      apiVersion: connection.apiVersion,
      scopes: connection.scopes,
      businessCenterId: connection.businessCenterId,
      selectedAdvertiserIds: connection.selectedAdvertiserIds,
      selectedCatalogIds: connection.selectedCatalogIds,
    };
  }

  private async assertCanManageStore(userId: string, storeId: string): Promise<void> {
    const membership = await this.repository.findMembership(userId, storeId);
    if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
      throw new AppError('Insufficient store role', 403, 'FORBIDDEN');
    }
  }
}
