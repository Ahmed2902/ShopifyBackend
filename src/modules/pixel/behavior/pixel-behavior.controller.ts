import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  analyticsListQuerySchema,
  analyticsRangeQuerySchema,
} from '../../analytics/analytics.schema.js';
import {
  derivePixelBehaviorInsights,
  pixelBehaviorInsightChangePoints,
} from './pixel-behavior-insights.js';
import {
  pixelBehaviorBatchReadService,
  type PixelBehaviorBatchReadService,
} from './pixel-behavior-batch.read.service.js';
import {
  pixelCheckoutPurchaseReadRepository,
  type PixelCheckoutPurchaseReadRepository,
} from './pixel-checkout-purchase.read.repository.js';
import {
  pixelBehaviorDetailService,
  type PixelBehaviorDetailService,
} from './pixel-behavior-detail.service.js';
import {
  pixelBehaviorSourceReadService,
  type PixelBehaviorSourceReadService,
} from './pixel-behavior-source.read.service.js';
import { pixelBehaviorService, type PixelBehaviorService } from './pixel-behavior.service.js';

const entityIdSchema = z.string().uuid();
const entityIdsSchema = z.string().transform((value, context) => {
  const ids = [...new Set(value.split(',').map((item) => item.trim()).filter(Boolean))];
  if (ids.length === 0 || ids.length > 100 || ids.some((id) => !z.string().uuid().safeParse(id).success)) {
    context.addIssue({ code: 'custom', message: 'ids must contain 1 to 100 comma-separated UUIDs' });
    return z.NEVER;
  }
  return ids;
});

export class PixelBehaviorController {
  constructor(
    private readonly service: PixelBehaviorService = pixelBehaviorService,
    private readonly checkoutPurchaseReadRepository: PixelCheckoutPurchaseReadRepository =
      pixelCheckoutPurchaseReadRepository,
    private readonly detailService: PixelBehaviorDetailService = pixelBehaviorDetailService,
    private readonly batchReadService: PixelBehaviorBatchReadService = pixelBehaviorBatchReadService,
    private readonly sourceReadService: PixelBehaviorSourceReadService = pixelBehaviorSourceReadService,
  ) {}

  overview = async (req: Request, res: Response) => {
    const report = await this.service.overview(
      req.context.storeId!,
      analyticsRangeQuerySchema.parse(req.query),
    );
    const checkoutPurchase = await this.checkoutPurchaseReadRepository.getOverlapCounts({
      storeId: req.context.storeId!,
      currentFrom: report.window.current.instantFrom,
      currentTo: report.window.current.instantTo,
      comparisonFrom: report.window.comparison.instantFrom,
      comparisonTo: report.window.comparison.instantTo,
    });
    const current = derivePixelBehaviorInsights({
      ...report.current,
      checkoutStartPurchaseSessions: checkoutPurchase.current,
    });
    const comparison = derivePixelBehaviorInsights({
      ...report.comparison,
      checkoutStartPurchaseSessions: checkoutPurchase.comparison,
    });

    res.status(200).json({
      ...report,
      understanding: {
        current: {
          ...current,
          checkoutStartPurchaseSessions: checkoutPurchase.current,
        },
        comparison: {
          ...comparison,
          checkoutStartPurchaseSessions: checkoutPurchase.comparison,
        },
        changePoints: pixelBehaviorInsightChangePoints(current, comparison),
        methodology: {
          cartAbandonment:
            'Observed cart-view sessions that did not contain a linked valid Shopify purchase.',
          checkoutAbandonment:
            'Observed checkout-start sessions that did not contain a linked non-test, non-cancelled Shopify purchase in the same materialized session.',
          largestFunnelDrop:
            'Largest valid stage-to-stage drop in the observed session funnel; non-monotonic stages are excluded rather than guessed.',
          interpretation: 'Observed behavior only; no causal explanation is implied.',
        },
      },
    });
  };

  products = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.products(
        req.context.storeId!,
        analyticsListQuerySchema.parse(req.query),
      ),
    );
  };

  productBatch = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.batchReadService.products(
        req.context.storeId!,
        entityIdsSchema.parse(req.query.ids),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  productSources = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.sourceReadService.product(
        req.context.storeId!,
        entityIdSchema.parse(req.params.productId),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  product = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.detailService.product(
        req.context.storeId!,
        entityIdSchema.parse(req.params.productId),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  collections = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.collections(
        req.context.storeId!,
        analyticsListQuerySchema.parse(req.query),
      ),
    );
  };

  collectionBatch = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.batchReadService.collections(
        req.context.storeId!,
        entityIdsSchema.parse(req.query.ids),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  collectionSources = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.sourceReadService.collection(
        req.context.storeId!,
        entityIdSchema.parse(req.params.collectionId),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  collection = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.detailService.collection(
        req.context.storeId!,
        entityIdSchema.parse(req.params.collectionId),
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
  };

  landingPages = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.landingPages(
        req.context.storeId!,
        analyticsListQuerySchema.parse(req.query),
      ),
    );
  };
}

export const pixelBehaviorController = new PixelBehaviorController();
