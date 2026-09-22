import { AppError } from '../../errors/app-error.js';
import { logger } from '../../lib/logger.js';
import { dashboardWorkspace, type DashboardWorkspace } from '../analytics/dashboard.workspace.js';
import { productAdsWorkspace, type ProductAdsWorkspace } from '../analytics/product-ads.workspace.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from '../intelligence/intelligence-snapshot.read.service.js';
import { pixelBehaviorService, type PixelBehaviorService } from '../pixel/behavior/pixel-behavior.service.js';
import { StoreRepository } from '../stores/store.repository.js';
import { knowledgeCatalog } from './business-knowledge.catalog.js';

type StoreReader = Pick<StoreRepository, 'findById'>;
type Section<T> = { available: true; data: T } | { available: false; data: null; error: string };

async function section<T>(
  storeId: string,
  sectionName: string,
  loader: () => Promise<T>,
): Promise<Section<T>> {
  try {
    return { available: true, data: await loader() };
  } catch (error) {
    logger.warn({ err: error, storeId, section: sectionName }, 'Advisor knowledge section unavailable');
    return {
      available: false,
      data: null,
      error: 'Knowledge section unavailable',
    };
  }
}

/**
 * Protocol-independent read model for an external marketing advisor.
 *
 * The service deliberately composes existing Stride workspaces instead of recalculating metrics.
 * That guarantees an MCP client sees the same commerce truth, provider attribution boundaries,
 * deterministic recommendations and limitations as the first-party Stride UI.
 */
export class BusinessKnowledgeService {
  constructor(
    private readonly stores: StoreReader = new StoreRepository(),
    private readonly dashboard: DashboardWorkspace = dashboardWorkspace,
    private readonly intelligence: IntelligenceSnapshotReadService = intelligenceSnapshotReadService,
    private readonly productAds: ProductAdsWorkspace = productAdsWorkspace,
    private readonly storefront: PixelBehaviorService = pixelBehaviorService,
  ) {}

  catalog() {
    return {
      version: '1.0',
      readOnly: true,
      advisorPurpose:
        'Give a connected LLM enough verified Stride context to act as a marketing advisor without inventing business facts or mutating merchant systems.',
      truthModel: {
        commerce: 'Shopify is commerce truth.',
        providerAttribution:
          'Meta/TikTok conversions and value remain provider-reported evidence and are never silently substituted for Shopify truth.',
        storefront: 'Stride Pixel is first-party observed storefront behavior, not causal proof.',
        intelligence:
          'Stride deterministic rules own calculations, recommendation evidence, confidence and limitations; an LLM may explain and combine them but must not silently recalculate authoritative facts.',
        currencies: 'Different currencies remain isolated unless an explicit conversion methodology exists.',
        privacy:
          'Advisor surfaces prefer aggregate customer/order knowledge and business entities; unnecessary customer PII is excluded.',
      },
      domains: knowledgeCatalog(),
    };
  }

  async context(storeId: string) {
    const store = await this.stores.findById(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    return {
      store: {
        id: store.id,
        name: store.name,
        myshopifyDomain: store.myshopifyDomain,
        primaryDomainHost: store.primaryDomainHost,
        primaryDomainUrl: store.primaryDomainUrl,
        currencyCode: store.currencyCode,
        presentmentCurrencies: store.enabledPresentmentCurrencies,
        timezone: store.ianaTimezone,
        createdAt: store.createdAt,
        updatedAt: store.updatedAt,
      },
      integrations: {
        shopify: store.shopifyConnection,
        meta: store.metaConnection,
        tiktok: store.tiktokConnection,
        pixel: store.pixelInstallation,
      },
      knowledge: this.catalog(),
    };
  }

  async snapshot(
    storeId: string,
    options: { days?: number; fresh?: boolean; productLimit?: number } = {},
  ) {
    const days = Math.min(Math.max(Math.trunc(options.days ?? 30), 1), 365);
    const productLimit = Math.min(Math.max(Math.trunc(options.productLimit ?? 8), 1), 20);
    const generatedAt = new Date();
    const range = { days };

    const [context, dashboard, intelligence, storefront, productAds] = await Promise.all([
      this.context(storeId),
      this.dashboard.read(storeId, range, generatedAt, { fresh: options.fresh ?? false }),
      section(storeId, 'intelligence', () =>
        this.intelligence.read(storeId, { fresh: options.fresh ?? false }),
      ),
      section(storeId, 'storefront', () => this.storefront.overview(storeId, range, generatedAt)),
      section(storeId, 'productAds', () =>
        this.productAds.list(
          storeId,
          { ...range, page: 1, limit: productLimit },
          generatedAt,
        ),
      ),
    ]);

    return {
      schemaVersion: '1.0',
      generatedAt,
      window: { days },
      context,
      overview: dashboard.overview,
      dashboardSections: dashboard.sections,
      intelligence: intelligence.available
        ? {
            available: true as const,
            data: {
              evaluatedAt: intelligence.data.evaluatedAt,
              recommendations: intelligence.data.recommendations,
              dataQuality: intelligence.data.dataQuality,
            },
          }
        : intelligence,
      storefront,
      productAds,
      advisorGuidance: {
        answerStyle:
          'Lead with the business conclusion, cite the Stride evidence that supports it, name important uncertainty, then suggest concrete next actions.',
        evidenceRules: [
          'Do not merge Shopify truth with provider attribution without naming the distinction.',
          'Do not call missing comparison data stable performance.',
          'Do not turn degraded/untrusted data into an all-clear or deterministic action.',
          'Treat recommendation limitations and evidence quality as part of the recommendation, not optional metadata.',
          'Use drill-down reads before making entity-specific claims that are not present in this snapshot.',
        ],
      },
    };
  }
}

export const businessKnowledgeService = new BusinessKnowledgeService();
