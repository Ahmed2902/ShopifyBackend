import { analyticsWorkspace, type AnalyticsWorkspace } from '../analytics/analytics.workspace.js';
import {
  tiktokMonitorEntityReadService,
  type TikTokMonitorEntityReadService,
} from '../analytics/tiktok-monitor-entity.read.service.js';
import { tiktokMonitorService, type TikTokMonitorService } from '../analytics/tiktok-monitor.service.js';
import type { AdvertisingPlatform } from './advertising.types.js';

export type PaidMediaLevel = 'CAMPAIGN' | 'AD_SET' | 'AD' | 'CREATIVE';

export interface PaidMediaReadQuery {
  days?: number;
  page?: number;
  limit?: number;
}

export interface PaidMediaProviderCapabilities {
  provider: AdvertisingPlatform;
  levels: PaidMediaLevel[];
  supportsCreativeAnalytics: boolean;
  supportsVideoRetention: boolean;
  attributionModel: 'PROVIDER_REPORTED';
  currencyPolicy: 'SEPARATE_BY_PROVIDER_CURRENCY';
  limitations: string[];
}

/**
 * Provider-neutral paid-media read boundary.
 *
 * Provider-specific persistence remains below this layer; consumers above it should use this
 * contract rather than reaching directly into Meta/TikTok tables.
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
    days: Math.min(Math.max(Math.trunc(query.days ?? 30), 1), 365),
    page: Math.max(Math.trunc(query.page ?? 1), 1),
    limit: Math.min(Math.max(Math.trunc(query.limit ?? 50), 1), 100),
  };
}

export class MetaAdvertisingEvidenceProvider implements AdvertisingEvidenceProvider {
  readonly provider = 'META' as const;

  constructor(private readonly analytics: AnalyticsWorkspace = analyticsWorkspace) {}

  capabilities(): PaidMediaProviderCapabilities {
    return {
      provider: this.provider,
      levels: ['CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE'],
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

  async overview(storeId: string, query: PaidMediaReadQuery = {}) {
    const { days } = bounded(query);
    return {
      provider: this.provider,
      capabilities: this.capabilities(),
      evidence: await this.analytics.advertising(storeId, { days }),
    };
  }

  async list(storeId: string, level: PaidMediaLevel, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    const range = { days: normalized.days, page: normalized.page, limit: normalized.limit };
    const evidence =
      level === 'CAMPAIGN'
        ? await this.analytics.campaigns(storeId, range)
        : level === 'AD_SET'
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
    const { days } = bounded(query);
    const evidence =
      level === 'CAMPAIGN'
        ? await this.analytics.campaign(storeId, entityId, { days })
        : level === 'AD_SET'
          ? await this.analytics.adSet(storeId, entityId, { days })
          : level === 'AD'
            ? await this.analytics.ad(storeId, entityId, { days })
            : await this.analytics.creative(storeId, entityId, { days });

    return { provider: this.provider, level, capabilities: this.capabilities(), evidence };
  }
}

export class TikTokAdvertisingEvidenceProvider implements AdvertisingEvidenceProvider {
  readonly provider = 'TIKTOK' as const;

  constructor(
    private readonly monitor: TikTokMonitorService = tiktokMonitorService,
    private readonly entityReads: TikTokMonitorEntityReadService = tiktokMonitorEntityReadService,
  ) {}

  capabilities(): PaidMediaProviderCapabilities {
    return {
      provider: this.provider,
      levels: ['CAMPAIGN', 'AD_SET', 'AD'],
      supportsCreativeAnalytics: false,
      supportsVideoRetention: false,
      attributionModel: 'PROVIDER_REPORTED',
      currencyPolicy: 'SEPARATE_BY_PROVIDER_CURRENCY',
      limitations: [
        'TikTok conversion/value metrics are provider-reported attribution and are not Shopify purchase truth.',
        'Only merchant-selected TikTok advertisers are included.',
        'TikTok monitor supports a maximum 90-day reporting window.',
        'TikTok monitor currently exposes campaigns, ad groups and ads; creative-level normalized analytics are not yet available.',
      ],
    };
  }

  async overview(storeId: string, query: PaidMediaReadQuery = {}) {
    const normalized = bounded(query);
    const days = Math.min(normalized.days, 90);
    const result = await this.monitor.read(storeId, {
      days,
      level: 'campaigns',
      page: 1,
      limit: 1,
      fresh: false,
    });
    return {
      provider: this.provider,
      capabilities: this.capabilities(),
      evidence: {
        connection: result.connection,
        window: result.window,
        counts: result.counts,
        summary: result.summary,
      },
    };
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
    const evidence = await this.monitor.read(storeId, {
      days: Math.min(normalized.days, 90),
      level: level === 'CAMPAIGN' ? 'campaigns' : level === 'AD_SET' ? 'groups' : 'ads',
      page: normalized.page,
      limit: normalized.limit,
      fresh: false,
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
    const evidence = await this.entityReads.read(storeId, {
      days: Math.min(normalized.days, 90),
      level: level === 'CAMPAIGN' ? 'campaigns' : level === 'AD_SET' ? 'groups' : 'ads',
      entityId,
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
