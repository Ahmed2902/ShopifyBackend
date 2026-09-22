import type { Request, Response } from 'express';
import { analyticsWorkspaceCachedReads } from '../../lib/store-decision-cache.js';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  analyticsEntityParamsSchema,
  analyticsListQuerySchema,
  analyticsRangeQuerySchema,
  analyticsReadControlSchema,
  type AnalyticsListQuery,
  type AnalyticsRangeQuery,
} from './analytics.schema.js';
import { analyticsWorkspace, type AnalyticsWorkspace } from './analytics.workspace.js';
import { productAdsWorkspace, type ProductAdsWorkspace } from './product-ads.workspace.js';

type CachedAnalyticsQuery = AnalyticsRangeQuery & Partial<Pick<AnalyticsListQuery, 'page' | 'limit'>>;

function entityId(req: Request, key: string): string {
  return analyticsEntityParamsSchema.parse({ entityId: req.params[key] }).entityId;
}

function analyticsCacheKey(
  storeId: string,
  domain: string,
  query: CachedAnalyticsQuery,
  ...identity: string[]
): string {
  return [
    storeId,
    domain,
    ...identity,
    query.from ?? '',
    query.to ?? '',
    String(query.days),
    query.accountId ?? '',
    query.page === undefined ? '' : String(query.page),
    query.limit === undefined ? '' : String(query.limit),
  ].join(':');
}

export class AnalyticsController {
  constructor(
    private readonly workspace: AnalyticsWorkspace,
    private readonly productAdsWorkspace: ProductAdsWorkspace,
  ) {}

  private cached<T>(
    storeId: string,
    key: string,
    fresh: boolean,
    loader: () => Promise<T>,
  ): Promise<T> {
    return analyticsWorkspaceCachedReads.run(key, loader, { fresh, versionScope: storeId });
  }

  overview = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(
      storeId,
      analyticsCacheKey(storeId, 'overview', query),
      fresh,
      async () => toJsonSafe(await this.workspace.overview(storeId, query)),
    );
    res.status(200).json(payload);
  };

  products = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'products', query), fresh, async () =>
      toJsonSafe(await this.workspace.products(storeId, query)),
    );
    res.status(200).json(payload);
  };

  product = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const id = entityId(req, 'productId');
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'product', query, id), fresh, async () =>
      toJsonSafe(await this.workspace.product(storeId, id, query)),
    );
    res.status(200).json(payload);
  };

  productAds = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'product-ads', query), fresh, async () =>
      toJsonSafe(await this.productAdsWorkspace.list(storeId, query)),
    );
    res.status(200).json(payload);
  };

  productAdsProduct = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const id = entityId(req, 'productId');
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'product-ads-product', query, id), fresh, async () =>
      toJsonSafe(await this.productAdsWorkspace.detail(storeId, id, query)),
    );
    res.status(200).json(payload);
  };

  collections = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'collections', query), fresh, async () =>
      toJsonSafe(await this.workspace.collections(storeId, query)),
    );
    res.status(200).json(payload);
  };

  customers = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'customers', query), fresh, async () =>
      toJsonSafe(await this.workspace.customers(storeId, query)),
    );
    res.status(200).json(payload);
  };

  inventory = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'inventory', query), fresh, async () =>
      toJsonSafe(await this.workspace.inventory(storeId, query)),
    );
    res.status(200).json(payload);
  };

  advertising = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'advertising', query), fresh, async () =>
      toJsonSafe(await this.workspace.advertising(storeId, query)),
    );
    res.status(200).json(payload);
  };

  campaigns = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'campaigns', query), fresh, async () =>
      toJsonSafe(await this.workspace.campaigns(storeId, query)),
    );
    res.status(200).json(payload);
  };

  campaign = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const id = entityId(req, 'campaignId');
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'campaign', query, id), fresh, async () =>
      toJsonSafe(await this.workspace.campaign(storeId, id, query)),
    );
    res.status(200).json(payload);
  };

  adSets = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'adsets', query), fresh, async () =>
      toJsonSafe(await this.workspace.adSets(storeId, query)),
    );
    res.status(200).json(payload);
  };

  adSet = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const id = entityId(req, 'adSetId');
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'adset', query, id), fresh, async () =>
      toJsonSafe(await this.workspace.adSet(storeId, id, query)),
    );
    res.status(200).json(payload);
  };

  ads = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'ads', query), fresh, async () =>
      toJsonSafe(await this.workspace.ads(storeId, query)),
    );
    res.status(200).json(payload);
  };

  ad = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const id = entityId(req, 'adId');
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'ad', query, id), fresh, async () =>
      toJsonSafe(await this.workspace.ad(storeId, id, query)),
    );
    res.status(200).json(payload);
  };

  creatives = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = analyticsListQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'creatives', query), fresh, async () =>
      toJsonSafe(await this.workspace.creatives(storeId, query)),
    );
    res.status(200).json(payload);
  };

  creative = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const id = entityId(req, 'creativeId');
    const query = analyticsRangeQuerySchema.parse(req.query);
    const { fresh } = analyticsReadControlSchema.parse(req.query);
    const payload = await this.cached(storeId, analyticsCacheKey(storeId, 'creative', query, id), fresh, async () =>
      toJsonSafe(await this.workspace.creative(storeId, id, query)),
    );
    res.status(200).json(payload);
  };
}

export const analyticsController = new AnalyticsController(analyticsWorkspace, productAdsWorkspace);
