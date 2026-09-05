import type { Request, Response } from 'express';
import { analyticsListQuerySchema } from '../../analytics/analytics.schema.js';
import { pixelMappingEvidenceQuerySchema } from './pixel-attribution.schema.js';
import {
  pixelAttributionService,
  type PixelAttributionService,
} from './pixel-attribution.service.js';

export class PixelAttributionController {
  constructor(private readonly service: PixelAttributionService = pixelAttributionService) {}

  sources = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.sources(
        req.context.storeId!,
        analyticsListQuerySchema.parse(req.query),
      ),
    );
  };

  metaAds = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.metaAds(
        req.context.storeId!,
        analyticsListQuerySchema.parse(req.query),
      ),
    );
  };

  paths = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.paths(
        req.context.storeId!,
        analyticsListQuerySchema.parse(req.query),
      ),
    );
  };

  mappingEvidence = async (req: Request, res: Response) => {
    const { targetType } = pixelMappingEvidenceQuerySchema.parse({
      targetType: req.query.targetType,
    });
    res.status(200).json(
      await this.service.mappingEvidence(
        req.context.storeId!,
        targetType,
        analyticsListQuerySchema.parse(req.query),
      ),
    );
  };
}

export const pixelAttributionController = new PixelAttributionController();
