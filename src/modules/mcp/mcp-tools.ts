import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { billingService, type BillingService, type V1AdProvider } from '../billing/billing.service.js';
import { advisorReadService, type AdvisorReadService } from '../business-knowledge/advisor-read.service.js';
import {
  recommendationLifecycleService,
  type RecommendationLifecycleService,
} from '../intelligence/recommendation-lifecycle.service.js';

const days = z.number().int().min(1).max(365).optional();
const page = z.number().int().min(1).optional();
const limit = z.number().int().min(1).max(100).optional();
const fresh = z.boolean().optional();

export type McpToolDefinition = {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: true;
    destructiveHint: false;
    idempotentHint: true;
    openWorldHint: false;
  };
};

const readAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const objectOutputSchema = {
  type: 'object',
  properties: { data: {} },
  required: ['data'],
  additionalProperties: false,
};

function schema(properties: Record<string, unknown>, required: string[] = []) {
  return {
    type: 'object',
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

const paginationProperties = {
  days: { type: 'integer', minimum: 1, maximum: 365, description: 'Analysis window in days. Defaults to 30.' },
  page: { type: 'integer', minimum: 1, description: '1-based page. Defaults to 1.' },
  limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum rows. Defaults to 50.' },
};

const advisorEntityTypes = [
  'PRODUCT',
  'COLLECTION',
  'CAMPAIGN',
  'AD_SET',
  'AD',
  'CREATIVE',
  'LANDING_PAGE',
  'ATTRIBUTION_SOURCE',
  'RECOMMENDATION',
] as const;

const paidMediaSearchTypes = new Set(['CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE']);
const paidMediaProviders: readonly V1AdProvider[] = ['META', 'TIKTOK'];

function providerAccessBlock(error: unknown): error is AppError {
  return (
    error instanceof AppError &&
    (error.code === 'PLAN_AD_CHANNEL_LIMIT' || error.code === 'PLAN_CHANNEL_SELECTION_REQUIRED')
  );
}

export const MCP_TOOLS: readonly McpToolDefinition[] = [
  {
    name: 'stride_get_context',
    title: 'Get Stride business context',
    description:
      'Get the connected merchant/store identity, currency, timezone, domains, integration readiness, freshness, and Stride truth-model rules. Use this before making assumptions about what data is connected or which currency/timezone applies.',
    inputSchema: schema({}),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_snapshot',
    title: 'Get advisor snapshot',
    description:
      'Get a compact cross-domain marketing-advisor snapshot: Shopify commerce truth, profitability/contribution, paid-media pressure, dashboard signals, deterministic Stride recommendations with lifecycle state and data quality, first-party storefront behavior including derived funnel understanding, and Product × Ads evidence. Start here for broad questions such as “how are we doing?”, “what changed?”, or “what needs attention?”. Drill down with the other tools before making entity-specific claims not present in the snapshot.',
    inputSchema: schema({
      days: paginationProperties.days,
      fresh: { type: 'boolean', description: 'Bypass Stride intelligence/dashboard caches when true. Use sparingly.' },
    }),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_search',
    title: 'Search Stride business evidence',
    description:
      'Search business entities and deterministic findings Stride knows about by name, internal/external id, or matching aggregate evidence. Searches Shopify products/collections, entitled Meta/TikTok paid-media entities, Pixel landing pages and attribution sources, and Stride recommendations; it deliberately excludes raw customer PII. Use it to resolve names before a detail call.',
    inputSchema: schema(
      {
        query: { type: 'string', minLength: 1, maxLength: 300, description: 'Name, identifier, or aggregate evidence phrase.' },
        entityTypes: {
          type: 'array',
          items: { enum: advisorEntityTypes },
          uniqueItems: true,
          maxItems: advisorEntityTypes.length,
        },
        days: paginationProperties.days,
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      ['query'],
    ),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_commerce',
    title: 'Read Shopify commerce intelligence',
    description:
      'Read Stride’s Shopify-grounded commerce intelligence. `overview` covers revenue/order value, refunds, discounts, customer mix, contribution and same-currency blended MER. `performance` returns the daily commerce/Meta trend series. `products`/`product` expose product economics, while `product_leaderboard` returns store-wide product ranking/totals. `collections` lists collection analytics and `collection_detail` returns the current Shopify collection and paginated membership snapshot. `customers` and `inventory` expose their analytical read models. Shopify remains the commerce source of truth.',
    inputSchema: schema(
      {
        surface: { enum: ['overview', 'performance', 'products', 'product', 'product_leaderboard', 'collections', 'collection_detail', 'customers', 'inventory'] },
        entityId: { type: 'string', format: 'uuid', description: 'Required for surface=product or collection_detail.' },
        ...paginationProperties,
      },
      ['surface'],
    ),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_paid_media',
    title: 'Read paid-media intelligence',
    description:
      'Read provider-reported paid-media evidence through Stride’s normalized provider layer while preserving the store plan’s selected advertising-channel entitlement. `overview`, `list`, and `detail` support Meta/TikTok according to returned capabilities. Meta-only `ad_exposure_list` and `ad_exposure_detail` add deterministic Shopify target mapping, mapping confidence/precision, current inventory context, and explicit shared-spend limitations. TikTok has exact campaign/ad-group/ad drill-down but no claimed creative parity. Provider conversion/value metrics are not Shopify purchase truth.',
    inputSchema: schema(
      {
        provider: { enum: ['META', 'TIKTOK'] },
        action: { enum: ['overview', 'list', 'detail', 'ad_exposure_list', 'ad_exposure_detail'] },
        level: { enum: ['CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE'], description: 'Required for action=list or detail.' },
        entityId: { type: 'string', description: 'Stride internal entity id. Required for detail or ad_exposure_detail.' },
        ...paginationProperties,
      },
      ['provider', 'action'],
    ),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_storefront',
    title: 'Read first-party storefront behavior',
    description:
      'Read Stride Pixel first-party observed behavior. `overview` includes the same derived cart abandonment, checkout abandonment, largest valid funnel drop, change points and methodology used by the Stride HTTP UI. `products`, `collections`, and `landing_pages` provide aggregate entity behavior. Observed behavior identifies where the funnel changes, not why it changed. Owner/admin-only Pixel operational health is intentionally not exposed by the generic store-scoped MCP token.',
    inputSchema: schema(
      {
        surface: { enum: ['overview', 'products', 'collections', 'landing_pages'] },
        ...paginationProperties,
      },
      ['surface'],
    ),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_attribution',
    title: 'Read first-party attribution evidence',
    description:
      'Read Stride first-party attribution and aggregate journey evidence separately from provider attribution. Sources and Meta-ad evidence follow the standard Pixel analytics entitlement; aggregate paths and PRODUCT/COLLECTION mapping evidence preserve Stride’s Pro advanced-attribution entitlement. Raw visitor/session journeys are intentionally not exposed through MCP.',
    inputSchema: schema(
      {
        surface: { enum: ['sources', 'meta_ads', 'paths', 'mappings'] },
        targetType: { enum: ['PRODUCT', 'COLLECTION'], description: 'Required for surface=mappings.' },
        ...paginationProperties,
      },
      ['surface'],
    ),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_product_ads',
    title: 'Read Product × Ads evidence',
    description:
      'Read the product-centric cross-domain connection between Shopify product economics and mapped Meta exposure. Returns mapping confidence/coverage, mapped vs shared/unmapped spend, contribution after mapped ads, and methodology. Use list for ranking/comparison and detail for one product. For the reverse ad-centric view with inventory context, use Meta ad exposure through stride_get_paid_media. Never allocate shared/multi-product spend as if it were exact.',
    inputSchema: schema(
      {
        action: { enum: ['list', 'detail'] },
        productId: { type: 'string', format: 'uuid', description: 'Required for detail.' },
        ...paginationProperties,
      },
      ['action'],
    ),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_recommendations',
    title: 'Read Stride recommendations',
    description:
      'Get Stride deterministic recommendations together with lifecycle state, evidence, evidence quality, attribution precision, limitations, confidence and data-quality context. Use this for “what should I do?” and “why did Stride flag this?” questions. Recommendations are advice only; MCP cannot execute the suggested action.',
    inputSchema: schema({ fresh: { type: 'boolean' } }),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_decision_settings',
    title: 'Read Stride decision settings',
    description:
      'Read the merchant settings that shape Stride deterministic decision rules without changing them. Returns the existing intelligence settings plus inventory-planning inputs such as restock lead time and low-stock threshold. Use this to explain why inventory-aware recommendations behave as they do.',
    inputSchema: schema({}),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
  {
    name: 'stride_get_report',
    title: 'Read historical Stride report',
    description:
      'Get a historical current-vs-comparison analytical report with commerce/advertising overview and plan-limited deterministic intelligence context, including recommendation lifecycle state, for a chosen day window. Use for retrospective questions, trend explanation and period comparisons.',
    inputSchema: schema({
      days: paginationProperties.days,
      fresh: { type: 'boolean' },
    }),
    outputSchema: objectOutputSchema,
    annotations: readAnnotations,
  },
] as const;

const contextInput = z.object({}).strict();
const snapshotInput = z.object({ days, fresh }).strict();
const searchInput = z
  .object({
    query: z.string().trim().min(1).max(300),
    entityTypes: z.array(z.enum(advisorEntityTypes)).max(advisorEntityTypes.length).optional(),
    days,
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const commerceInput = z
  .object({
    surface: z.enum(['overview', 'performance', 'products', 'product', 'product_leaderboard', 'collections', 'collection_detail', 'customers', 'inventory']),
    entityId: z.string().uuid().optional(),
    days,
    page,
    limit,
  })
  .strict();
const paidMediaInput = z
  .object({
    provider: z.enum(['META', 'TIKTOK']),
    action: z.enum(['overview', 'list', 'detail', 'ad_exposure_list', 'ad_exposure_detail']),
    level: z.enum(['CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE']).optional(),
    entityId: z.string().min(1).max(256).optional(),
    days,
    page,
    limit,
  })
  .strict();
const storefrontInput = z
  .object({ surface: z.enum(['overview', 'products', 'collections', 'landing_pages']), days, page, limit })
  .strict();
const attributionInput = z
  .object({
    surface: z.enum(['sources', 'meta_ads', 'paths', 'mappings']),
    targetType: z.enum(['PRODUCT', 'COLLECTION']).optional(),
    days,
    page,
    limit,
  })
  .strict();
const productAdsInput = z
  .object({ action: z.enum(['list', 'detail']), productId: z.string().uuid().optional(), days, page, limit })
  .strict();
const recommendationInput = z.object({ fresh }).strict();
const decisionSettingsInput = z.object({}).strict();
const reportInput = z.object({ days, fresh }).strict();

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

function requireMeta(provider: 'META' | 'TIKTOK', action: string) {
  if (provider !== 'META') throw new Error(`${action} is currently supported only for provider=META`);
}

export class McpToolExecutor {
  constructor(
    private readonly reads: AdvisorReadService = advisorReadService,
    private readonly billing: BillingService = billingService,
    private readonly recommendationLifecycle: RecommendationLifecycleService = recommendationLifecycleService,
  ) {}

  async call(storeId: string, name: string, rawArguments: unknown) {
    const args = rawArguments ?? {};
    switch (name) {
      case 'stride_get_context':
        contextInput.parse(args);
        return this.reads.context(storeId);
      case 'stride_get_snapshot':
        return this.reads.snapshot(storeId, snapshotInput.parse(args));
      case 'stride_search': {
        const input = searchInput.parse(args);
        const requested = input.entityTypes?.length ? input.entityTypes : [...advisorEntityTypes];
        const needsPaidMedia = requested.some((type) => paidMediaSearchTypes.has(type));
        if (!needsPaidMedia) return this.reads.search(storeId, input);

        const plan = await this.billing.requireActive(storeId);
        let allowedProviders: V1AdProvider[];
        let blockedProviders: Array<{ provider: V1AdProvider; code: string; message: string }>;

        if (plan.entitlements.maxAdChannels === null) {
          allowedProviders = [...paidMediaProviders];
          blockedProviders = [];
        } else {
          const selected = plan.essentialsAdProvider as V1AdProvider | null;
          if (selected) {
            allowedProviders = paidMediaProviders.filter((provider) => provider === selected);
            blockedProviders = paidMediaProviders
              .filter((provider) => provider !== selected)
              .map((provider) => ({
                provider,
                code: 'PLAN_AD_CHANNEL_LIMIT',
                message:
                  'Essentials includes one advertising channel. Choose the existing channel or upgrade to Pro.',
              }));
          } else {
            const providerChecks = await Promise.all(
              paidMediaProviders.map(async (provider) => {
                try {
                  await this.billing.requireAdProviderReadOnly(storeId, provider);
                  return { provider, allowed: true as const };
                } catch (error) {
                  if (!providerAccessBlock(error)) throw error;
                  return {
                    provider,
                    allowed: false as const,
                    code: error.code,
                    message: error.message,
                  };
                }
              }),
            );
            allowedProviders = providerChecks
              .filter((check) => check.allowed)
              .map((check) => check.provider);
            blockedProviders = providerChecks
              .filter((check) => !check.allowed)
              .map((check) => ({ provider: check.provider, code: check.code, message: check.message }));
          }
        }

        const result = await this.reads.search(storeId, {
          ...input,
          paidMediaProviders: allowedProviders,
        });
        return {
          ...result,
          paidMediaAccess: { allowedProviders, blockedProviders },
        };
      }
      case 'stride_get_commerce': {
        const input = commerceInput.parse(args);
        if (input.surface === 'overview') return this.reads.overview(storeId, input.days);
        if (input.surface === 'performance') return this.reads.performance(storeId, input.days);
        if (input.surface === 'products') return this.reads.products(storeId, input);
        if (input.surface === 'product') {
          return this.reads.product(
            storeId,
            required(input.entityId, 'entityId is required for surface=product'),
            input.days,
          );
        }
        if (input.surface === 'product_leaderboard') return this.reads.productLeaderboard(storeId, input);
        if (input.surface === 'collections') return this.reads.collections(storeId, input);
        if (input.surface === 'collection_detail') {
          return this.reads.collectionDetail(
            storeId,
            required(input.entityId, 'entityId is required for surface=collection_detail'),
            input,
          );
        }
        if (input.surface === 'customers') return this.reads.customers(storeId, input.days);
        return this.reads.inventory(storeId, input);
      }
      case 'stride_get_paid_media': {
        const input = paidMediaInput.parse(args);
        let detailEntityId: string | undefined;
        let level: 'CAMPAIGN' | 'AD_SET' | 'AD' | 'CREATIVE' | undefined;

        if (input.action === 'ad_exposure_list' || input.action === 'ad_exposure_detail') {
          requireMeta(input.provider, input.action);
          if (input.action === 'ad_exposure_detail') {
            detailEntityId = required(input.entityId, 'entityId is required for ad_exposure_detail');
          }
        } else if (input.action === 'list' || input.action === 'detail') {
          level = required(input.level, 'level is required for paid-media list/detail');
          if (input.action === 'detail') {
            detailEntityId = required(input.entityId, 'entityId is required for paid-media detail');
          }
        }

        // Validate provider/action/detail shape before touching billing or provider data so malformed
        // requests are cheap to reject and cannot amplify database work.
        await this.billing.requireAdProviderReadOnly(storeId, input.provider);

        if (input.action === 'ad_exposure_list') return this.reads.adExposureList(storeId, input);
        if (input.action === 'ad_exposure_detail') {
          return this.reads.adExposureDetail(storeId, detailEntityId!, input.days);
        }
        if (input.action === 'overview') return this.reads.paidMediaOverview(storeId, input.provider, input.days);
        if (input.action === 'list') return this.reads.paidMediaList(storeId, input.provider, level!, input);
        return this.reads.paidMediaDetail(
          storeId,
          input.provider,
          level!,
          detailEntityId!,
          input.days,
        );
      }
      case 'stride_get_storefront': {
        const input = storefrontInput.parse(args);
        if (input.surface === 'overview') return this.reads.storefrontOverview(storeId, input.days);
        if (input.surface === 'products') return this.reads.storefrontProducts(storeId, input);
        if (input.surface === 'collections') return this.reads.storefrontCollections(storeId, input);
        return this.reads.storefrontLandingPages(storeId, input);
      }
      case 'stride_get_attribution': {
        const input = attributionInput.parse(args);
        if (input.surface === 'sources') return this.reads.attributionSources(storeId, input);
        if (input.surface === 'meta_ads') return this.reads.attributionMetaAds(storeId, input);
        if (input.surface === 'mappings') {
          const targetType = required(input.targetType, 'targetType is required for surface=mappings');
          await this.billing.requireEntitlement(storeId, 'ADVANCED_ATTRIBUTION');
          return this.reads.attributionMappings(storeId, targetType, input);
        }
        await this.billing.requireEntitlement(storeId, 'ADVANCED_ATTRIBUTION');
        return this.reads.attributionPaths(storeId, input);
      }
      case 'stride_get_product_ads': {
        const input = productAdsInput.parse(args);
        if (input.action === 'list') return this.reads.productAdsList(storeId, input);
        return this.reads.productAdsDetail(
          storeId,
          required(input.productId, 'productId is required for detail'),
          input.days,
        );
      }
      case 'stride_get_recommendations':
        return this.reads.recommendations(storeId, recommendationInput.parse(args));
      case 'stride_get_decision_settings': {
        decisionSettingsInput.parse(args);
        const [intelligence, inventoryPlanning] = await Promise.all([
          this.reads.intelligenceSettings(storeId),
          this.reads.inventoryPlanningSettings(storeId),
        ]);
        return { intelligence, inventoryPlanning };
      }
      case 'stride_get_report': {
        const input = reportInput.parse(args);
        const [report, plan] = await Promise.all([
          this.reads.report(storeId, input),
          this.billing.requireActive(storeId),
        ]);
        const recommendationLimit = Math.max(
          1,
          Number(plan.entitlements.recommendationLimit ?? 10),
        );
        const intelligence = report.sections.intelligence;
        if (!intelligence.available) return report;
        const recommendations = await this.recommendationLifecycle.attach(
          storeId,
          intelligence.data.recommendations.slice(0, recommendationLimit),
        );
        return {
          ...report,
          sections: {
            ...report.sections,
            intelligence: {
              ...intelligence,
              data: {
                ...intelligence.data,
                recommendations,
                entitlement: { recommendationLimit },
              },
            },
          },
        };
      }
      default:
        throw new Error(`Unknown Stride MCP tool: ${name}`);
    }
  }
}

export const mcpToolExecutor = new McpToolExecutor();
