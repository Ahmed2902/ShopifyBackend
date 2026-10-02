import type { AdvertisingProvider } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { billingService, type BillingService } from '../billing/billing.service.js';
import { MetaRepository } from '../meta/meta.repository.js';
import { MetaApiService } from '../meta/shared/meta-api.service.js';
import { MetaAuthService } from '../meta/shared/meta-auth.service.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';

export type ManagedConversionOption = {
  id: string;
  name: string;
  accountName: string;
  adAccountId: string;
  lastActivityAt: string | null;
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

function parseMetaPixel(value: unknown): { id: string; name: string; lastActivityAt: string | null } | null {
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
    if (context.selectedAdAccountIds.length === 0) {
      return {
        provider,
        automaticSetupAvailable: true,
        ready: false,
        needsPermission: !context.scopes.includes('ads_management'),
        needsAdAccountSelection: true,
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

    options.sort((a, b) => a.name.localeCompare(b.name) || a.accountName.localeCompare(b.accountName));
    const needsPermission = !context.scopes.includes('ads_management');
    return {
      provider,
      automaticSetupAvailable: true,
      ready: !needsPermission && options.length > 0,
      needsPermission,
      needsAdAccountSelection: false,
      options,
    };
  }

  async enable(storeId: string, provider: AdvertisingProvider, optionId: string) {
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
        'Reconnect Meta once to allow Stride to send confirmed Shopify purchases automatically',
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
