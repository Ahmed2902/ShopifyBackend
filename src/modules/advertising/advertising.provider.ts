import { analyticsWorkspace, type AnalyticsWorkspace } from '../analytics/analytics.workspace.js';
import { MetaRepository } from '../meta/meta.repository.js';
import { TikTokRepository } from '../tiktok/tiktok.repository.js';
import {
  advertisingAccountScopeService,
  type AdvertisingAccountScopeService,
} from './advertising-account-scope.service.js';
import {
  canonicalPaidMediaReadService,
  type CanonicalPaidMediaReadService,
} from './canonical-paid-media.read.service.js';
import type { AdvertisingDeliveryGroupKind, AdvertisingPlatform } from './advertising.types.js';

export type PaidMediaLevel = 'CAMPAIGN' | 'GROUP' | 'AD' | 'CREATIVE';

export interface PaidMediaReadQuery {
  /** Canonical AdvertisingAccount.id. When supplied it must belong to this store/provider selection. */
  accountId?: string;
  days?: number;
  page?: number;
  limit?: number;
}

export interface PaidMediaProviderCapabilities {
  provider: AdvertisingPlatform;
  levels: PaidMediaLevel[];
  groupKinds: AdvertisingDeliveryGroupKind[];
  groupLabel: 'Ad Set' | 'Ad Group' | 'Ad Group / Asset Group';
  supportsCreativeAnalytics: boolean;
  supportsVideoRetention: boolean;
  attributionModel: 'PROVIDER_REPORTED';
  currencyPolicy: 'SEPARATE_BY_PROVIDER_CURRENCY';
  limitations: string[];
}

/**
 * Minimal provider-neutral paid-media application boundary.
 *
 * Consumer vocabulary is Account -> Campaign -> Group -> Ad -> Creative/Asset. Provider-specific
 * labels and structural kinds are capabilities/presentation metadata and never leak into the level
 * selector. Ingestion may retain native provider tables for rollback, but runtime reads should use
 * canonical Advertising* persistence whenever that provider has completed canonical cutover.
 */
export interface AdvertisingEvidenceProvider {
  readonly provider: AdvertisingPlatform;
  capabilities(): PaidMediaProviderCapabilities;
  overview(storeId: string, query?: PaidMediaReadQuery): Promise<unknown>;
  list(storeId: string, level: PaidMediaLevel, query?: PaidMediaReadQuery): Promise<unknown>;
  detail(storeId: string, level: PaidMediaLevel, entityId: string, query?: PaidMediaReadQuery): Promise<unknown>;
}

function bounded(query: PaidMediaReadQuery = {}) {
  return {
    accountId: query.accountId,
    days: Math.min(Math.max(Math.trunc(query.days ?? 30), 1), 365),
    page: Math.max(Math.trunc(query.page ?? 1), 1),
    limit: Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 100),
  };
}

export class MetaAdvertisingEvidenceProvider implements AdvertisingEvidenceProvider {
  readonly provider = 'META' as const;

  constructor(
    private readonly analytics: AnalyticsWorkspace = analyticsWorkspace,
    private readonly metaRepository: MetaRepository = new MetaRepository(),
    private readonly accountScope: AdvertisingAccountScopeService = advertisingAccountScopeService,
  ) {}

  capabilities(): PaidMediaProviderCapabilities {
    return {
      provider: this.provider,
      levels: ['CAMPAIGN', 'GROUP', 'AD', 'CREATIVE'],
      groupKinds: ['AD_SET'],
      groupLabel: 'Ad Set',
      supportsCreativeAnalytics: true,
      supportsVideoRetention: true,
      attributionModel: 'PROVIDER_REPORTED',
      currencyPolicy: 'SEPARATE_BY_PROVIDER_CURRENCY',
      limitations: [
        'Meta conversion/value metrics are provider-reported attribution and are not Shopify purchase truth.',
        'Only merchant-selected Meta ad accounts are included.',
      ],
    };
  }

  /**
   * The provider-neutral boundary accepts a canonical AdvertisingAccount UUID. AnalyticsWorkspace
   * still scopes Meta reads by Meta's selected external account ID, so translate only inside this
   * adapter after validating the canonical UUID against store + provider + merchant selection.
   */
  private async selectedMetaAccountId(storeId: string, canonicalAccountId?: string) {
    if (!canonicalAccountId) return undefined;

    const connection = await this.metaRepository.findConnectionForStore(storeId);
    const [account] = await this.accountScope.resolve({
      storeId,
      provider: this.provider,
      selectedAccountExternalIds: connection?.selectedAdAccountIds ?? [],
      accountId: canonicalAccountId,
    });
    return account.providerEntityId;
  }

  async overview(storeId: string, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    const accountId = await this.selectedMetaAccountId(storeId, normalized.accountId);
    return {
      provider: this.provider,
      capabilities: this.capabilities(),
      evidence: await this.analytics.advertising(storeId, {
        days: normalized.days,
        ...(accountId ? { accountId } : {}),
      }),
    };
  }

  async list(storeId: string, level: PaidMediaLevel, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    const accountId = await this.selectedMetaAccountId(storeId, normalized.accountId);
    const range = {
      days: normalized.days,
      page: normalized.page,
      limit: normalized.limit,
      ...(accountId ? { accountId } : {}),
    };
    const evidence =
      level === 'CAMPAIGN'
        ? await this.analytics.campaigns(storeId, range)
        : level === 'GROUP'
          ? await this.analytics.adSets(storeId, range)
          : level === 'AD'
            ? await this.analytics.ads(storeId, range)
            : await this.analytics.creatives(storeId, range);

    return { provider: this.provider, level, capabilities: this.capabilities(), evidence };
  }

  async detail(
    storeId: string,
    level: PaidMediaLevel,
    entityId: string,
    query: PaidMediaReadQuery = {},
  ) {
    const normalized = bounded(query);
    const accountId = await this.selectedMetaAccountId(storeId, normalized.accountId);
    const range = {
      days: normalized.days,
      ...(accountId ? { accountId } : {}),
    };
    const evidence =
      level === 'CAMPAIGN'
        ? await this.analytics.campaign(storeId, entityId, range)
        : level === 'GROUP'
          ? await this.analytics.adSet(storeId, entityId, range)
          : level === 'AD'
            ? await this.analytics.ad(storeId, entityId, range)
            : await this.analytics.creative(storeId, entityId, range);

    return { provider: this.provider, level, capabilities: this.capabilities(), evidence };
  }
}

export class TikTokAdvertisingEvidenceProvider implements AdvertisingEvidenceProvider {
  readonly provider = 'TIKTOK' as const;

  constructor(
    private readonly canonicalReads: CanonicalPaidMediaReadService = canonicalPaidMediaReadService,
    private readonly tiktokRepository: TikTokRepository = new TikTokRepository(),
  ) {}

  capabilities(): PaidMediaProviderCapabilities {
    return {
      provider: this.provider,
      levels: ['CAMPAIGN', 'GROUP', 'AD'],
      groupKinds: ['AD_GROUP'],
      groupLabel: 'Ad Group',
      supportsCreativeAnalytics: false,
      supportsVideoRetention: false,
      attributionModel: 'PROVIDER_REPORTED',
      currencyPolicy: 'SEPARATE_BY_PROVIDER_CURRENCY',
      limitations: [
        'TikTok conversion/value metrics are provider-reported attribution and are not Shopify purchase truth.',
        'Only merchant-selected TikTok advertisers are included.',
        'TikTok canonical reads support a maximum 90-day reporting window.',
        'TikTok native tables remain ingestion/rollback evidence; production hierarchy and metric reads use canonical Advertising* tables.',
        'TikTok creative-level normalized analytics are not exposed until trustworthy first-class creative evidence is available.',
      ],
    };
  }

  private async selectedAdvertiserIds(storeId: string) {
    const connection = await this.tiktokRepository.findConnectionForStore(storeId);
    return connection?.selectedAdvertiserIds ?? [];
  }

  async overview(storeId: string, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    const selectedAccountExternalIds = await this.selectedAdvertiserIds(storeId);
    const evidence = await this.canonicalReads.overview({
      storeId,
      provider: this.provider,
      selectedAccountExternalIds,
      accountId: normalized.accountId,
      days: Math.min(normalized.days, 90),
    });
    return { provider: this.provider, capabilities: this.capabilities(), evidence };
  }

  async list(storeId: string, level: PaidMediaLevel, query: PaidMediaReadQuery = {}) {
    if (level === 'CREATIVE') {
      return {
        provider: this.provider,
        level,
        capabilities: this.capabilities(),
        unsupported: true,
        reason: 'TikTok creative-level normalized analytics are not available in Stride yet.',
      };
    }

    const normalized = bounded(query);
    const selectedAccountExternalIds = await this.selectedAdvertiserIds(storeId);
    const evidence = await this.canonicalReads.list({
      storeId,
      provider: this.provider,
      selectedAccountExternalIds,
      accountId: normalized.accountId,
      level,
      days: Math.min(normalized.days, 90),
      page: normalized.page,
      limit: normalized.limit,
    });
    return { provider: this.provider, level, capabilities: this.capabilities(), evidence };
  }

  async detail(
    storeId: string,
    level: PaidMediaLevel,
    entityId: string,
    query: PaidMediaReadQuery = {},
  ) {
    if (level === 'CREATIVE') {
      return {
        provider: this.provider,
        level,
        capabilities: this.capabilities(),
        unsupported: true,
        reason: 'TikTok creative-level normalized analytics are not available in Stride yet.',
      };
    }

    const normalized = bounded(query);
    const selectedAccountExternalIds = await this.selectedAdvertiserIds(storeId);
    const evidence = await this.canonicalReads.detail({
      storeId,
      provider: this.provider,
      selectedAccountExternalIds,
      accountId: normalized.accountId,
      level,
      entityId,
      days: Math.min(normalized.days, 90),
    });
    return {
      provider: this.provider,
      level,
      capabilities: this.capabilities(),
      evidence,
      limitations: evidence.item
        ? []
        : ['No matching entity is available within the connected store and merchant-selected TikTok advertisers.'],
    };
  }
}

export class AdvertisingProviderRegistry {
  private readonly providers = new Map<AdvertisingPlatform, AdvertisingEvidenceProvider>();

  constructor(
    providers: AdvertisingEvidenceProvider[] = [
      new MetaAdvertisingEvidenceProvider(),
      new TikTokAdvertisingEvidenceProvider(),
    ],
  ) {
    for (const provider of providers) this.providers.set(provider.provider, provider);
  }

  get(provider: AdvertisingPlatform) {
    const adapter = this.providers.get(provider);
    if (!adapter) throw new Error(`Unsupported paid-media provider: ${provider}`);
    return adapter;
  }

  supportedProviders() {
    return [...this.providers.keys()];
  }

  capabilities() {
    return [...this.providers.values()].map((provider) => provider.capabilities());
  }
}

export const advertisingProviderRegistry = new AdvertisingProviderRegistry();
