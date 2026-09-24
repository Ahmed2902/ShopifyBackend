import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { decryptSecret, encryptSecret } from '../../integrations/integration.utils.js';
import type { GoogleAdsRepository } from '../google-ads.repository.js';
import type { GoogleAdsApiContext } from '../google-ads.types.js';
import {
  buildGoogleAdsAuthorizationUrl,
  GOOGLE_ADS_OAUTH_SCOPE,
  verifyGoogleAdsOAuthState,
} from '../google-ads.utils.js';
import type { GoogleAdsApiService } from './google-ads-api.service.js';

export class GoogleAdsAuthService {
  constructor(
    private readonly repository: GoogleAdsRepository,
    private readonly api: GoogleAdsApiService,
  ) {}

  async startInstall(userId: string, storeId: string) {
    await this.assertCanManageStore(userId, storeId);
    return buildGoogleAdsAuthorizationUrl(userId, storeId);
  }

  async completeInstall(code: string, state: string) {
    const oauth = verifyGoogleAdsOAuthState(state);
    await this.assertCanManageStore(oauth.userId, oauth.storeId);
    const exchanged = await this.api.exchangeAuthorizationCode(code);
    if (!exchanged.scopes.includes(GOOGLE_ADS_OAUTH_SCOPE)) {
      throw new AppError(
        'Google Ads did not grant the required adwords scope',
        403,
        'GOOGLE_ADS_SCOPE_REQUIRED',
      );
    }
    const accessible = await this.api.listAccessibleCustomers(
      exchanged.accessToken,
      env.GOOGLE_ADS_API_VERSION,
    );
    if (accessible.length === 0) {
      throw new AppError(
        'Google Ads did not grant access to any customer accounts',
        403,
        'GOOGLE_ADS_CUSTOMER_ACCESS_REQUIRED',
      );
    }
    const connection = await this.repository.upsertConnection({
      storeId: oauth.storeId,
      accessTokenCiphertext: encryptSecret(exchanged.accessToken),
      accessTokenExpiresAt: new Date(Date.now() + exchanged.expiresIn * 1000),
      refreshTokenCiphertext: encryptSecret(exchanged.refreshToken),
      scopes: exchanged.scopes,
      apiVersion: env.GOOGLE_ADS_API_VERSION,
    });
    return {
      storeId: connection.storeId,
      connectionId: connection.id,
      accessibleCustomerIds: accessible,
    };
  }

  async getApiContext(storeId: string): Promise<GoogleAdsApiContext> {
    const connection = await this.repository.findConnectionForStore(storeId);
    if (!connection || connection.status === 'DISCONNECTED') {
      throw new AppError(
        'Google Ads is not connected for this store',
        409,
        'GOOGLE_ADS_NOT_CONNECTED',
      );
    }
    if (connection.status === 'REAUTH_REQUIRED' || !connection.refreshTokenCiphertext) {
      throw new AppError(
        'Google Ads connection requires reauthorization',
        401,
        'GOOGLE_ADS_REAUTH_REQUIRED',
      );
    }
    if (!connection.scopes.includes(GOOGLE_ADS_OAUTH_SCOPE)) {
      await this.repository.markReauthRequired(connection.id);
      throw new AppError(
        'Google Ads connection is missing the required adwords scope',
        401,
        'GOOGLE_ADS_REAUTH_REQUIRED',
      );
    }
    let accessToken = connection.accessTokenCiphertext
      ? decryptSecret(connection.accessTokenCiphertext)
      : '';
    const expiresSoon =
      !connection.accessTokenExpiresAt ||
      connection.accessTokenExpiresAt.getTime() <= Date.now() + 5 * 60_000;
    if (!accessToken || expiresSoon) {
      try {
        const refreshed = await this.api.refreshAccessToken(
          decryptSecret(connection.refreshTokenCiphertext),
        );
        accessToken = refreshed.accessToken;
        await this.repository.updateAccessToken(
          connection.id,
          encryptSecret(accessToken),
          new Date(Date.now() + refreshed.expiresIn * 1000),
        );
      } catch (error) {
        await this.repository.markReauthRequired(connection.id);
        throw error;
      }
    }
    return {
      connectionId: connection.id,
      storeId,
      accessToken,
      apiVersion: connection.apiVersion,
      scopes: connection.scopes,
      selectedCustomerIds: connection.selectedCustomerIds,
    };
  }

  async disconnect(storeId: string) {
    const connection = await this.repository.findConnectionForStore(storeId);
    if (!connection) return null;

    if (connection.refreshTokenCiphertext) {
      try {
        await this.api.revokeToken(decryptSecret(connection.refreshTokenCiphertext));
      } catch {
        // Local credential erasure is authoritative even when remote revocation already happened/fails.
      }
    }

    await this.repository.disconnect(storeId);
    const disconnected = await this.repository.findConnectionForStore(storeId);
    if (!disconnected) return null;
    return {
      id: disconnected.id,
      status: disconnected.status,
      selectedCustomerIds: disconnected.selectedCustomerIds,
      scopes: disconnected.scopes,
      apiVersion: disconnected.apiVersion,
      lastSyncedAt: disconnected.lastSyncedAt,
      lastSyncStatus: disconnected.lastSyncStatus,
      lastSyncError: disconnected.lastSyncError,
    };
  }

  verifyState(value: unknown) {
    return verifyGoogleAdsOAuthState(value);
  }

  private async assertCanManageStore(userId: string, storeId: string) {
    const membership = await this.repository.findMembership(userId, storeId);
    if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    if (membership.role !== 'OWNER' && membership.role !== 'ADMIN') {
      throw new AppError('Insufficient store role', 403, 'FORBIDDEN');
    }
  }
}
