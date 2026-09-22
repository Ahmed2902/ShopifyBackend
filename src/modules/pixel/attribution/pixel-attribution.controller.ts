import type { Request, Response } from 'express';
import { AppError } from '../../../errors/app-error.js';
import {
  analyticsListQuerySchema,
  type AnalyticsListQuery,
} from '../../analytics/analytics.schema.js';
import { pixelMappingEvidenceQuerySchema } from './pixel-attribution.schema.js';
import {
  pixelAttributionService,
  type PixelAttributionService,
} from './pixel-attribution.service.js';

function attributionQuery(query: Request['query']): AnalyticsListQuery {
  const parsed = analyticsListQuerySchema.parse(query);
  // Pixel attribution rollups are store-scoped first-party journey evidence. They do not retain
  // a selected Meta-account dimension for every source/path row, so accepting accountId would
  // falsely imply that the response was filtered. Fail closed until that dimension exists.
  if (parsed.accountId) {
    throw new AppError(
      'Account-scoped first-party attribution is not supported by this read model',
      400,
      'ACCOUNT_SCOPED_ATTRIBUTION_UNSUPPORTED',
    );
  }
  return parsed;
}

export class PixelAttributionController {
  constructor(private readonly service: PixelAttributionService = pixelAttributionService) {}

  sources = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.sources(req.context.storeId!, attributionQuery(req.query)),
    );
  };

  metaAds = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.metaAds(req.context.storeId!, attributionQuery(req.query)),
    );
  };

  paths = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.paths(req.context.storeId!, attributionQuery(req.query)),
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
        attributionQuery(req.query),
      ),
    );
  };
}

export const pixelAttributionController = new PixelAttributionController();
