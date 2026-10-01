import type { Request, Response } from 'express';
import { z } from 'zod';
import { advertisingReconciliationService } from './advertising-reconciliation.service.js';

const providerParams = z.object({
  provider: z.enum(['META', 'TIKTOK', 'GOOGLE_ADS']),
});

export class AdvertisingReconciliationController {
  status = async (req: Request, res: Response) => {
    res.status(200).json({
      providers: await advertisingReconciliationService.status(req.context.storeId!),
    });
  };

  sync = async (req: Request, res: Response) => {
    const { provider } = providerParams.parse(req.params);
    const result = await advertisingReconciliationService.requestManual(
      req.context.storeId!,
      provider,
    );
    res.status(result.status === 'COOLDOWN' ? 200 : 202).json(result);
  };
}

export const advertisingReconciliationController = new AdvertisingReconciliationController();
