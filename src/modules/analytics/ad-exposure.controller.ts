import type { Request, Response } from 'express';
import { toJsonSafe } from '../meta/meta.utils.js';
import {
  analyticsEntityParamsSchema,
  analyticsListQuerySchema,
  analyticsRangeQuerySchema,
} from './analytics.schema.js';
import { adExposureWorkspace, type AdExposureWorkspace } from './ad-exposure.workspace.js';

export class AdExposureController {
  constructor(private readonly workspace: AdExposureWorkspace) {}

  list = async (req: Request, res: Response) => {
    res.status(200).json(
      toJsonSafe(
        await this.workspace.list(
          req.context.storeId!,
          analyticsListQuerySchema.parse(req.query),
        ),
      ),
    );
  };

  detail = async (req: Request, res: Response) => {
    const adId = analyticsEntityParamsSchema.parse({ entityId: req.params.adId }).entityId;
    res.status(200).json(
      toJsonSafe(
        await this.workspace.detail(
          req.context.storeId!,
          adId,
          analyticsRangeQuerySchema.parse(req.query),
        ),
      ),
    );
  };
}

export const adExposureController = new AdExposureController(adExposureWorkspace);
