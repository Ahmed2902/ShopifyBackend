import type { AdvertisingProvider } from '../../generated/prisma/client.js';
import { GoogleAdsRepository } from '../google-ads/google-ads.repository.js';
import { GoogleAdsApiService } from '../google-ads/shared/google-ads-api.service.js';
import { GoogleAdsAuthService } from '../google-ads/shared/google-ads-auth.service.js';
import { GOOGLE_DATA_MANAGER_SCOPE } from './conversion-delivery.types.js';
import { AppError } from '../../errors/app-error.js';
import { billingService, type BillingService } from '../billing/billing.service.js';
import { MetaRepository } from '../meta/meta.repository.js';
import { MetaApiService } from '../meta/shared/meta-api.service.js';
import { MetaAuthService } from '../meta/shared/meta-auth.service.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';
import { env } from '../../config/env.js';
import { TikTokRepository } from '../tiktok/tiktok.repository.js';
import { TikTokApiService } from '../tiktok/shared/tiktok-api.service.js';
import { TikTokAuthService } from '../tiktok/shared/tiktok-auth.service.js';
import { listTikTokPixels } from './tiktok-pixels.js';

export type ManagedConversionOption = {
  id: string;
  name: string;
  accountName: string;
  adAccountId: string;
  lastActivityAt: string | null;
  customerId?: string;
  loginCustomerId?: string;
  destinationId?: string;
};

export type ManagedConversionOptions = {
  provider: AdvertisingProvider;
  automaticSetupAvailable: boolean;
  ready: boolean;
  needsPermission: boolean;
  needsAdAccountSelection: boolean;
  options: ManagedConversionOption[];
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseMetaPixel(
  value: unknown,
): { id: string; name: string; lastActivityAt: string | null } | null {
  const record = asRecord(value);
  if (!record || typeof record.id !== 'string' || record.id.length === 0) return null;
  const rawName = typeof record.name === 'string' ? record.name.trim() : '';
  const lastActivityAt =
    typeof record.last_fired_time === 'string'
      ? record.last_fired_time
      : typeof record.last_fired_time === 'number'
        ? new Date(record.last_fired_time * 1000).toISOString()
        : null;
  return {
    id: record.id,
    name: rawName || 'Meta store tracking',
    lastActivityAt,
  };
}

export class ManagedConversionSetupService {
  constructor(
    private readonly repository: ConversionDeliveryRepository = new ConversionDeliveryRepository(),
    private readonly billing: BillingService = billingService,
    private readonly metaRepository: MetaRepository = new MetaRepository(),
  ) {}

  private metaServices() {
    const api = new MetaApiService(this.metaRepository);
    return { api, auth: new MetaAuthService(this.metaRepository, api) };
  }

  async options(storeId: string, provider: AdvertisingProvider): Promise<ManagedConversionOptions> {
    await this.billing.requireAdProvider(storeId, provider);

    if (provider === 'GOOGLE_ADS') return this.googleOptions(storeId);
    if (provider === 'TIKTOK') return this.tiktokOptions(storeId);

    if (provider !== 'META') {
      return {
        provider,
        automaticSetupAvailable: false,
        ready: false,
        needsPermission: false,
        needsAdAccountSelection: false,
        options: [],
      };
    }

    const { api, auth } = this.metaServices();
    const context = await auth.getApiContext(storeId);
    const needsPermission = !context.scopes.includes('ads_management');
    if (context.selectedAdAccountIds.length === 0 || needsPermission) {
      return {
        provider,
        automaticSetupAvailable: true,
        ready: false,
        needsPermission,
        needsAdAccountSelection: context.selectedAdAccountIds.length === 0,
        options: [],
      };
    }

    const groups = await Promise.all(
      context.selectedAdAccountIds.map(async (adAccountId) => {
        const [account, pixels] = await Promise.all([
          api.getAdAccount(context, adAccountId),
          api.collectGraphPages(
            context,
            `/${adAccountId}/adspixels`,
            { fields: 'id,name,last_fired_time', limit: '100' },
            parseMetaPixel,
          ),
        ]);
        return { account, pixels };
      }),
    );

    const seen = new Set<string>();
    const options: ManagedConversionOption[] = [];
    for (const group of groups) {
      for (const pixel of group.pixels) {
        if (seen.has(pixel.id)) continue;
        seen.add(pixel.id);
        options.push({
          id: pixel.id,
          name: pixel.name,
          accountName: group.account.name,
          adAccountId: group.account.id,
          lastActivityAt: pixel.lastActivityAt,
        });
      }
    }

    options.sort(
      (a, b) => a.name.localeCompare(b.name) || a.accountName.localeCompare(b.accountName),
    );
    return {
      provider,
      automaticSetupAvailable: true,
      ready: options.length > 0,
      needsPermission: false,
      needsAdAccountSelection: false,
      options,
    };
  }

  private async tiktokOptions(storeId: string): Promise<ManagedConversionOptions> {
    const result: ManagedConversionOptions = {
      provider: 'TIKTOK',
      automaticSetupAvailable: env.TIKTOK_EVENTS_API_ENABLED,
      ready: false,
      needsPermission: !env.TIKTOK_EVENTS_API_ENABLED,
      needsAdAccountSelection: false,
      options: [],
    };
    if (!env.TIKTOK_EVENTS_API_ENABLED) return result;
    const repository = new TikTokRepository();
    const api = new TikTokApiService();
    const context = await new TikTokAuthService(repository, api).getApiContext(storeId);
    result.needsAdAccountSelection = context.selectedAdvertiserIds.length === 0;
    if (result.needsAdAccountSelection) return result;
    const groups = await Promise.all(
      context.selectedAdvertiserIds.map(async (advertiserId) => {
        const pixels = await listTikTokPixels(api, context, advertiserId);
        return pixels.map((pixel) => ({
          id: `${advertiserId}:${pixel.code}`,
          name: pixel.name,
          accountName: 'TikTok advertiser',
          adAccountId: advertiserId,
          destinationId: pixel.code,
          lastActivityAt: null,
        }));
      }),
    );
    result.options = [...new Map(groups.flat().map((option) => [option.id, option])).values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    result.ready = result.options.length > 0;
    return result;
  }

  private async googleOptions(storeId: string): Promise<ManagedConversionOptions> {
    const repository = new GoogleAdsRepository();
    const api = new GoogleAdsApiService();
    const auth = new GoogleAdsAuthService(repository, api);
    const context = await auth.getApiContext(storeId);
    const needsPermission = !context.scopes.includes(GOOGLE_DATA_MANAGER_SCOPE);
    const result: ManagedConversionOptions = {
      provider: 'GOOGLE_ADS',
      automaticSetupAvailable: true,
      ready: false,
      needsPermission,
      needsAdAccountSelection: context.selectedCustomerIds.length === 0,
      options: [],
    };
    if (needsPermission || result.needsAdAccountSelection) return result;
    const accounts = await repository.findSelectedCustomers(storeId, context.selectedCustomerIds);
    const groups = await Promise.all(
      accounts
        .filter((account) => !account.manager)
        .map(async (account) => {
          const rows = await api.search({
            accessToken: context.accessToken,
            apiVersion: context.apiVersion,
            customerId: account.customerId,
            loginCustomerId: account.loginCustomerId,
            query:
              "SELECT conversion_action.id, conversion_action.name, conversion_action.status, conversion_action.type, conversion_action.category, conversion_action.owner_customer FROM conversion_action WHERE conversion_action.status = 'ENABLED' AND conversion_action.type = 'UPLOAD_CLICKS' AND conversion_action.category = 'PURCHASE'",
          });
          return rows.flatMap((row) => {
            const action = asRecord(row.conversionAction);
            // Manager-owned actions require a different operating account. Never infer that account.
            if (
              !action ||
              action.status !== 'ENABLED' ||
              action.type !== 'UPLOAD_CLICKS' ||
              action.category !== 'PURCHASE' ||
              action.ownerCustomer !== `customers/${account.customerId}` ||
              !/^[0-9]+$/.test(String(action.id))
            )
              return [];
            return [
              {
                id: `${account.customerId}:${action.id}`,
                name:
                  typeof action.name === 'string' && action.name.trim()
                    ? action.name.trim()
                    : 'Google purchase action',
                accountName: account.descriptiveName || 'Google Ads account',
                adAccountId: account.customerId,
                customerId: account.customerId,
                ...(account.loginCustomerId ? { loginCustomerId: account.loginCustomerId } : {}),
                destinationId: String(action.id),
                lastActivityAt: null,
              },
            ];
          });
        }),
    );
    result.options = [...new Map(groups.flat().map((option) => [option.id, option])).values()].sort(
      (a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id),
    );
    result.ready = result.options.length > 0;
    return result;
  }

  async enable(storeId: string, provider: AdvertisingProvider, optionId: string) {
    if (provider === 'TIKTOK') {
      const setup = await this.options(storeId, provider);
      if (!setup.automaticSetupAvailable)
        throw new AppError(
          'TikTok Events API permission must be approved before purchase sharing is available',
          409,
          'TIKTOK_EVENTS_APPROVAL_REQUIRED',
        );
      const selected = setup.options.find((option) => option.id === optionId);
      if (!selected?.destinationId)
        throw new AppError(
          'The selected TikTok tracking destination is no longer available',
          400,
          'TIKTOK_CONVERSION_DESTINATION_NOT_ACCESSIBLE',
        );
      return this.repository.upsertDestination(
        storeId,
        {
          provider,
          externalId: selected.destinationId,
          displayName: selected.name,
          config: { authSource: 'TIKTOK_CONNECTION', advertiserId: selected.adAccountId },
        },
        undefined,
      );
    }
    if (provider === 'GOOGLE_ADS') {
      const setup = await this.options(storeId, provider);
      if (setup.needsPermission)
        throw new AppError(
          'Reconnect Google Ads once to allow purchase sharing',
          403,
          'GOOGLE_DATA_MANAGER_SCOPE_REQUIRED',
        );
      if (setup.needsAdAccountSelection)
        throw new AppError(
          'Choose a Google Ads account before enabling purchase sharing',
          409,
          'GOOGLE_ADS_CUSTOMERS_NOT_CONFIGURED',
        );
      const selected = setup.options.find((option) => option.id === optionId);
      if (!selected?.customerId || !selected.destinationId)
        throw new AppError(
          'The selected Google purchase action is no longer available',
          400,
          'GOOGLE_CONVERSION_DESTINATION_NOT_ACCESSIBLE',
        );
      return this.repository.upsertDestination(
        storeId,
        {
          provider,
          externalId: selected.destinationId,
          displayName: selected.name,
          config: {
            authSource: 'GOOGLE_ADS_CONNECTION',
            customerId: selected.customerId,
            ...(selected.loginCustomerId ? { loginCustomerId: selected.loginCustomerId } : {}),
          },
        },
        undefined,
      );
    }
    if (provider !== 'META') {
      throw new AppError(
        'Automatic purchase sharing setup is not available for this channel yet',
        409,
        'MANAGED_CONVERSION_SETUP_UNAVAILABLE',
      );
    }

    const setup = await this.options(storeId, provider);
    if (setup.needsPermission) {
      throw new AppError(
        'Reconnect Meta once to allow Metrico to send confirmed Shopify purchases automatically',
        403,
        'META_ADS_MANAGEMENT_REQUIRED',
      );
    }
    if (setup.needsAdAccountSelection) {
      throw new AppError(
        'Choose a Meta ad account before enabling purchase sharing',
        409,
        'META_ASSETS_NOT_CONFIGURED',
      );
    }

    const selected = setup.options.find((option) => option.id === optionId);
    if (!selected) {
      throw new AppError(
        'The selected Meta purchase destination is no longer available',
        400,
        'META_CONVERSION_DESTINATION_NOT_ACCESSIBLE',
      );
    }

    return this.repository.upsertDestination(
      storeId,
      {
        provider: 'META',
        externalId: selected.id,
        displayName: selected.name,
        config: {
          authSource: 'META_CONNECTION',
          adAccountId: selected.adAccountId,
        },
      },
      undefined,
    );
  }
}

export const managedConversionSetupService = new ManagedConversionSetupService();
