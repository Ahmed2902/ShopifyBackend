import type { Request, Response } from 'express';
import {
  analyticsListQuerySchema,
  analyticsRangeQuerySchema,
} from '../../analytics/analytics.schema.js';
import {
  derivePixelBehaviorInsights,
  pixelBehaviorInsightChangePoints,
} from './pixel-behavior-insights.js';
import { pixelBehaviorService, type PixelBehaviorService } from './pixel-behavior.service.js';

export class PixelBehaviorController {
  constructor(private readonly service: PixelBehaviorService = pixelBehaviorService) {}

  overview = async (req: Request, res: Response) => {
    const report = await this.service.overview(
      req.context.storeId!,
      analyticsRangeQuerySchema.parse(req.query),
    );
    const current = derivePixelBehaviorInsights(report.current);
    const comparison = derivePixelBehaviorInsights(report.comparison);
    res.status(200).json({
      ...report,
      understanding: {
        current,
        comparison,
        changePoints: pixelBehaviorInsightChangePoints(current, comparison),
        methodology: {
          cartAbandonment:
            'Observed cart-view sessions that did not contain a linked valid Shopify purchase.',
          checkoutAbandonment:
            'Observed checkout-start sessions that did not emit checkout completion in the same materialized session.',
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

  collections = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.collections(
        req.context.storeId!,
        analyticsListQuerySchema.parse(req.query),
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
