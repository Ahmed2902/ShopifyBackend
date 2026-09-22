import { z } from 'zod';
import { advisorReadService, type AdvisorReadService } from '../business-knowledge/advisor-read.service.js';

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
      'Get a compact cross-domain marketing-advisor snapshot: Shopify commerce truth, profitability/contribution, paid-media pressure, dashboard signals, deterministic Stride recommendations and data quality, first-party storefront behavior, and Product × Ads evidence. Start here for broad questions such as “how are we doing?”, “what changed?”, or “what needs attention?”. Drill down with the other tools before making entity-specific claims not present in the snapshot.',
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
      'Search business entities and deterministic findings Stride knows about by name, internal/external id, or matching evidence. Searches products, collections, paid-media entities and Stride recommendations; it deliberately excludes raw customer PII. Use it to resolve names before a detail call.',
    inputSchema: schema(
      {
        query: { type: 'string', minLength: 1, maxLength: 300, description: 'Name, identifier, or evidence phrase.' },
        entityTypes: {
          type: 'array',
          items: { enum: ['PRODUCT', 'COLLECTION', 'CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE', 'RECOMMENDATION'] },
          uniqueItems: true,
          maxItems: 7,
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
      'Read Stride’s Shopify-grounded commerce intelligence. `overview` covers revenue/order value, refunds, discounts, customer mix, contribution and same-currency blended MER. `products`/`product` expose product economics. `collections`, `customers`, and `inventory` expose their corresponding analytical read models. Shopify remains the commerce source of truth.',
    inputSchema: schema(
      {
        surface: { enum: ['overview', 'products', 'product', 'collections', 'customers', 'inventory'] },
        entityId: { type: 'string', format: 'uuid', description: 'Required only for surface=product.' },
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
      'Read provider-reported paid-media evidence through Stride’s normalized provider layer. Supports Meta and TikTok while preserving each provider’s capabilities, attribution limitations and currencies. Use `overview`, `list`, or `detail`; levels are campaign, ad set, ad, or creative where supported. Provider conversion/value metrics are not Shopify purchase truth.',
    inputSchema: schema(
      {
        provider: { enum: ['META', 'TIKTOK'] },
        action: { enum: ['overview', 'list', 'detail'] },
        level: { enum: ['CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE'], description: 'Required for list/detail.' },
        entityId: { type: 'string', description: 'Stride internal entity id. Required for detail.' },
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
      'Read Stride Pixel first-party observed behavior. `overview` covers sessions and funnel/abandonment evidence; `products`, `collections`, and `landing_pages` provide entity-level behavior. Always respect returned data-quality/freshness limitations. Observed behavior identifies where the funnel changes, not why it changed.',
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
      'Read Stride first-party attribution and journey evidence separately from provider attribution. Surfaces include traffic sources, Meta-ad attribution evidence, journey paths, and PRODUCT/COLLECTION mapping evidence. Use this to compare first-party observed paths with provider-reported results without blending the models.',
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
      'Read the cross-domain connection between Shopify product economics and mapped Meta exposure. Returns mapping confidence/coverage, mapped vs shared/unmapped spend, contribution after mapped ads, and methodology. Use list for ranking/comparison and detail for one product. Never allocate shared/multi-product spend as if it were exact.',
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
    name: 'stride_get_report',
    title: 'Read historical Stride report',
    description:
      'Get a historical current-vs-comparison analytical report with commerce/advertising overview and deterministic intelligence context for a chosen day window. Use for retrospective questions, trend explanation and period comparisons.',
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
    entityTypes: z
      .array(z.enum(['PRODUCT', 'COLLECTION', 'CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE', 'RECOMMENDATION']))
      .max(7)
      .optional(),
    days,
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();
const commerceInput = z
  .object({
    surface: z.enum(['overview', 'products', 'product', 'collections', 'customers', 'inventory']),
    entityId: z.string().uuid().optional(),
    days,
    page,
    limit,
  })
  .strict();
const paidMediaInput = z
  .object({
    provider: z.enum(['META', 'TIKTOK']),
    action: z.enum(['overview', 'list', 'detail']),
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
const reportInput = z.object({ days, fresh }).strict();

function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}

export class McpToolExecutor {
  constructor(private readonly reads: AdvisorReadService = advisorReadService) {}

  async call(storeId: string, name: string, rawArguments: unknown) {
    const args = rawArguments ?? {};
    switch (name) {
      case 'stride_get_context':
        contextInput.parse(args);
        return this.reads.context(storeId);
      case 'stride_get_snapshot':
        return this.reads.snapshot(storeId, snapshotInput.parse(args));
      case 'stride_search':
        return this.reads.search(storeId, searchInput.parse(args));
      case 'stride_get_commerce': {
        const input = commerceInput.parse(args);
        if (input.surface === 'overview') return this.reads.overview(storeId, input.days);
        if (input.surface === 'products') return this.reads.products(storeId, input);
        if (input.surface === 'product') {
          return this.reads.product(
            storeId,
            required(input.entityId, 'entityId is required for surface=product'),
            input.days,
          );
        }
        if (input.surface === 'collections') return this.reads.collections(storeId, input);
        if (input.surface === 'customers') return this.reads.customers(storeId, input.days);
        return this.reads.inventory(storeId, input);
      }
      case 'stride_get_paid_media': {
        const input = paidMediaInput.parse(args);
        if (input.action === 'overview') return this.reads.paidMediaOverview(storeId, input.provider, input.days);
        const level = required(input.level, 'level is required for paid-media list/detail');
        if (input.action === 'list') return this.reads.paidMediaList(storeId, input.provider, level, input);
        return this.reads.paidMediaDetail(
          storeId,
          input.provider,
          level,
          required(input.entityId, 'entityId is required for paid-media detail'),
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
        if (input.surface === 'paths') return this.reads.attributionPaths(storeId, input);
        return this.reads.attributionMappings(
          storeId,
          required(input.targetType, 'targetType is required for surface=mappings'),
          input,
        );
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
      case 'stride_get_report':
        return this.reads.report(storeId, reportInput.parse(args));
      default:
        throw new Error(`Unknown Stride MCP tool: ${name}`);
    }
  }
}

export const mcpToolExecutor = new McpToolExecutor();
