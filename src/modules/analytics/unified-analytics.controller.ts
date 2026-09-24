import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { analyticsWorkspaceCachedReads } from '../../lib/store-decision-cache.js';
import {
  unifiedAdvertisingListQuerySchema,
  unifiedAdvertisingRangeQuerySchema,
  type UnifiedAdvertisingRangeQuery,
} from '../advertising/unified-advertising.schema.js';
import {
  unifiedAdvertisingIntelligenceService,
  type UnifiedAdvertisingIntelligenceService,
} from '../advertising/unified-advertising-intelligence.service.js';
import {
  unifiedPaidEntityService,
  type UnifiedPaidEntityService,
} from '../advertising/unified-paid-entity.service.js';
import type { UnifiedPaidEntityKind } from '../advertising/unified-paid-entity.repository.js';
import {
  unifiedDataQualityService,
  type UnifiedDataQualityService,
} from '../intelligence/unified-data-quality.service.js';
import {
  unifiedDecisionService,
  type UnifiedDecisionService,
} from '../intelligence/unified-decision.service.js';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  unifiedProductAdsIntelligenceService,
  type UnifiedProductAdsIntelligenceService,
} from './unified-product-ads-intelligence.service.js';

function cacheKey(
  storeId: string,
  domain: string,
  query: UnifiedAdvertisingRangeQuery & { page?: number; limit?: number },
  identity?: string,
) {
  return [
    storeId,
    domain,
    identity ?? '',
    query.provider,
    query.accountId ?? '',
    query.currency ?? '',
    query.from ?? '',
    query.to ?? '',
    String(query.days),
    query.page === undefined ? '' : String(query.page),
    query.limit === undefined ? '' : String(query.limit),
  ].join(':');
}

function stringParam(value: string | string[] | undefined, name: string) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError(`${name} is required`, 400, 'INVALID_ROUTE_PARAMETER');
  }
  return value;
}

export class UnifiedAnalyticsController {
  constructor(
    private readonly advertising: UnifiedAdvertisingIntelligenceService =
      unifiedAdvertisingIntelligenceService,
    private readonly productAds: UnifiedProductAdsIntelligenceService =
      unifiedProductAdsIntelligenceService,
    private readonly paidEntities: UnifiedPaidEntityService = unifiedPaidEntityService,
    private readonly decisions: UnifiedDecisionService = unifiedDecisionService,
    private readonly dataQualityReads: UnifiedDataQualityService = unifiedDataQualityService,
  ) {}

  private cached<T>(storeId: string, key: string, fresh: boolean, loader: () => Promise<T>) {
    return analyticsWorkspaceCachedReads.run(key, loader, { fresh, versionScope: storeId });
  }

  private async entityList(kind: UnifiedPaidEntityKind, req: Request, res: Response) {
    const storeId = req.context.storeId!;
    const query = unifiedAdvertisingListQuerySchema.parse(req.query);
    const payload = await this.cached(
      storeId,
      cacheKey(storeId, `unified-${kind.toLowerCase()}`, query),
      req.query.fresh === 'true',
      async () => toJsonSafe(await this.paidEntities.list(storeId, kind, query)),
    );
    res.status(200).json(payload);
  }

  advertisingOverview = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = unifiedAdvertisingRangeQuerySchema.parse(req.query);
    const payload = await this.cached(
      storeId,
      cacheKey(storeId, 'unified-advertising', query),
      req.query.fresh === 'true',
      async () => toJsonSafe(await this.advertising.read(storeId, query)),
    );
    res.status(200).json(payload);
  };

  home = this.advertisingOverview;

  dataQuality = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = unifiedAdvertisingRangeQuerySchema.parse(req.query);
    const payload = await this.cached(
      storeId,
      cacheKey(storeId, 'unified-data-quality', query),
      req.query.fresh === 'true',
      async () => toJsonSafe(await this.dataQualityReads.read(storeId, query)),
    );
    res.status(200).json(payload);
  };

  decisionList = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = unifiedAdvertisingRangeQuerySchema.parse(req.query);
    const payload = await this.cached(
      storeId,
      cacheKey(storeId, 'unified-decisions', query),
      req.query.fresh === 'true',
      async () => toJsonSafe(await this.decisions.read(storeId, query)),
    );
    res.status(200).json(payload);
  };

  campaigns = (req: Request, res: Response) => this.entityList('CAMPAIGN', req, res);
  groups = (req: Request, res: Response) => this.entityList('GROUP', req, res);
  ads = (req: Request, res: Response) => this.entityList('AD', req, res);
  creatives = (req: Request, res: Response) => this.entityList('CREATIVE', req, res);

  productAdsList = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = unifiedAdvertisingListQuerySchema.parse(req.query);
    const payload = await this.cached(
      storeId,
      cacheKey(storeId, 'unified-product-ads', query),
      req.query.fresh === 'true',
      async () => toJsonSafe(await this.productAds.list(storeId, query)),
    );
    res.status(200).json(payload);
  };

  productAdsDetail = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const query = unifiedAdvertisingRangeQuerySchema.parse(req.query);
    const productId = stringParam(req.params.productId, 'productId');
    const payload = await this.cached(
      storeId,
      cacheKey(storeId, 'unified-product-ads-product', query, productId),
      req.query.fresh === 'true',
      async () => toJsonSafe(await this.productAds.detail(storeId, productId, query)),
    );
    res.status(200).json(payload);
  };
}

export const unifiedAnalyticsController = new UnifiedAnalyticsController();
