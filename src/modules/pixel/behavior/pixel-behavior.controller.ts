import type { Request, Response } from 'express';
import {
  analyticsListQuerySchema,
  analyticsRangeQuerySchema,
} from '../../analytics/analytics.schema.js';
import {
  pixelBehaviorOverviewReadService,
  type PixelBehaviorOverviewReadService,
} from './pixel-behavior-overview.read.service.js';
import { pixelBehaviorService, type PixelBehaviorService } from './pixel-behavior.service.js';

export class PixelBehaviorController {
  constructor(
    private readonly service: PixelBehaviorService = pixelBehaviorService,
    private readonly overviewReads: PixelBehaviorOverviewReadService = pixelBehaviorOverviewReadService,
  ) {}

  overview = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.overviewReads.read(
        req.context.storeId!,
        analyticsRangeQuerySchema.parse(req.query),
      ),
    );
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
