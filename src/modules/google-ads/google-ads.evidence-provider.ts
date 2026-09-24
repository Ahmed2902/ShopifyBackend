import { prisma } from '../../lib/prisma.js';
import { advertisingAccountScopeService } from '../advertising/advertising-account-scope.service.js';
import { canonicalPaidMediaReadService } from '../advertising/canonical-paid-media.read.service.js';
import type { AdvertisingEvidenceProvider, PaidMediaLevel, PaidMediaProviderCapabilities, PaidMediaReadQuery } from '../advertising/advertising.provider.js';
import { GoogleAdsRepository } from './google-ads.repository.js';

function bounded(query: PaidMediaReadQuery = {}) {
  return {
    accountId: query.accountId,
    days: Math.min(Math.max(Math.trunc(query.days ?? 30), 1), 365),
    page: Math.max(Math.trunc(query.page ?? 1), 1),
    limit: Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 100),
  };
}

export class GoogleAdsAdvertisingEvidenceProvider implements AdvertisingEvidenceProvider {
  readonly provider = 'GOOGLE_ADS' as const;
  constructor(private readonly repository = new GoogleAdsRepository()) {}

  capabilities(): PaidMediaProviderCapabilities {
    return {
      provider: this.provider,
      levels: ['CAMPAIGN', 'GROUP', 'AD', 'CREATIVE'],
      groupKinds: ['AD_GROUP', 'ASSET_GROUP'],
      groupLabel: 'Ad Group / Asset Group',
      supportsCreativeAnalytics: false,
      supportsVideoRetention: false,
      attributionModel: 'PROVIDER_REPORTED',
      currencyPolicy: 'SEPARATE_BY_PROVIDER_CURRENCY',
      limitations: [
        'Google conversions, conversion value and ROAS are provider-reported attribution, not Shopify revenue truth.',
        'Performance Max is Campaign -> Asset Group; Stride does not invent Google ad entities where Google does not expose them.',
        'Google assets are exposed as canonical creative/asset entities; asset-level delivery metrics are not claimed.',
        'Period reach is unavailable because daily reach is non-additive and Stride does not fabricate deduplicated reach.',
        'Only merchant-selected Google Ads client customer accounts are included.',
      ],
    };
  }

  private async selectedCustomerIds(storeId: string) {
    const connection = await this.repository.findConnectionForStore(storeId);
    return connection?.selectedCustomerIds ?? [];
  }

  private async scope(storeId: string, accountId?: string) {
    return advertisingAccountScopeService.resolve({
      storeId,
      provider: this.provider,
      selectedAccountExternalIds: await this.selectedCustomerIds(storeId),
      accountId,
    });
  }

  async overview(storeId: string, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    const evidence = await canonicalPaidMediaReadService.overview({
      storeId,
      provider: this.provider,
      selectedAccountExternalIds: await this.selectedCustomerIds(storeId),
      accountId: normalized.accountId,
      days: normalized.days,
    });
    return { provider: this.provider, capabilities: this.capabilities(), evidence };
  }

  async list(storeId: string, level: PaidMediaLevel, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    if (level !== 'CREATIVE') {
      const evidence = await canonicalPaidMediaReadService.list({
        storeId,
        provider: this.provider,
        selectedAccountExternalIds: await this.selectedCustomerIds(storeId),
        accountId: normalized.accountId,
        level,
        days: normalized.days,
        page: normalized.page,
        limit: normalized.limit,
      });
      return { provider: this.provider, level, capabilities: this.capabilities(), evidence };
    }

    const accounts = await this.scope(storeId, normalized.accountId);
    const accountIds = accounts.map((account) => account.id);
    const skip = (normalized.page - 1) * normalized.limit;
    const [items, total] = await Promise.all([
      prisma.advertisingCreative.findMany({
        where: { accountId: { in: accountIds }, deletedAt: null },
        select: {
          id: true,
          accountId: true,
          providerEntityId: true,
          name: true,
          title: true,
          body: true,
          imageUrl: true,
          videoId: true,
          providerData: true,
        },
        orderBy: [{ providerUpdatedAt: 'desc' }, { id: 'asc' }],
        skip,
        take: normalized.limit,
      }),
      prisma.advertisingCreative.count({ where: { accountId: { in: accountIds }, deletedAt: null } }),
    ]);
    return {
      provider: this.provider,
      level,
      capabilities: this.capabilities(),
      evidence: { accounts, items, page: normalized.page, limit: normalized.limit, total, metricsUnavailable: true },
    };
  }

  async detail(storeId: string, level: PaidMediaLevel, entityId: string, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    if (level !== 'CREATIVE') {
      const evidence = await canonicalPaidMediaReadService.detail({
        storeId,
        provider: this.provider,
        selectedAccountExternalIds: await this.selectedCustomerIds(storeId),
        accountId: normalized.accountId,
        level,
        entityId,
        days: normalized.days,
      });
      return { provider: this.provider, level, capabilities: this.capabilities(), evidence };
    }

    const accounts = await this.scope(storeId, normalized.accountId);
    const accountIds = accounts.map((account) => account.id);
    const item = await prisma.advertisingCreative.findFirst({
      where: { id: entityId, accountId: { in: accountIds }, deletedAt: null },
      select: {
        id: true,
        accountId: true,
        providerEntityId: true,
        name: true,
        title: true,
        body: true,
        imageUrl: true,
        videoId: true,
        providerData: true,
      },
    });
    return {
      provider: this.provider,
      level,
      capabilities: this.capabilities(),
      evidence: { accounts, item, metricsUnavailable: true },
    };
  }
}
