import type { Request, Response } from 'express';
import { metaTrackingApplySchema } from './meta-tracking.schema.js';
import { metaTrackingService, type MetaTrackingService } from './meta-tracking.service.js';

export class MetaTrackingController {
  constructor(private readonly service: MetaTrackingService) {}

  permissionUpgrade = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.startPermissionUpgrade(req.context.userId!, req.context.storeId!),
    );
  };

  manualConfiguration = async (_req: Request, res: Response) => {
    res.status(200).json(this.service.manualConfiguration());
  };

  audit = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.audit(req.context.storeId!));
  };

  apply = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.apply(
        req.context.storeId!,
        metaTrackingApplySchema.parse(req.body ?? {}),
      ),
    );
  };
}

export const metaTrackingController = new MetaTrackingController(metaTrackingService);
