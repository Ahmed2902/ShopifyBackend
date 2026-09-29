import type { Request, Response } from 'express';
import { unifiedAdvertisingRangeQuerySchema } from '../advertising/unified-advertising.schema.js';
import { advertisingDailyReadService } from './advertising-daily.read.service.js';

export class AdvertisingDailyController {
  read = async (req: Request, res: Response) => {
    res.status(200).json(
      await advertisingDailyReadService.read(
        req.context.storeId!,
        unifiedAdvertisingRangeQuerySchema.parse(req.query),
      ),
    );
  };
}

export const advertisingDailyController = new AdvertisingDailyController();
