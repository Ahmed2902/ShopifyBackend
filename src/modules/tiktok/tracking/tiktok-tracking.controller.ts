import type { Request, Response } from 'express';
import { tiktokTrackingApplySchema } from './tiktok-tracking.schema.js';
import { tiktokTrackingService } from './tiktok-tracking.service.js';
export const tiktokTrackingController = {
  manual: (_req: Request, res: Response) => res.json(tiktokTrackingService.manualConfiguration()),
  audit: async (req: Request, res: Response) =>
    res.json(await tiktokTrackingService.audit(req.context.storeId!)),
  apply: async (req: Request, res: Response) =>
    res.json(
      await tiktokTrackingService.apply(
        req.context.storeId!,
        tiktokTrackingApplySchema.parse(req.body),
      ),
    ),
};
