import type { Request, Response } from 'express';
import { z } from 'zod';
import type { IntegrationService } from './integration.service.js';

const syncRunQuerySchema = z.object({
  provider: z.enum(['SHOPIFY', 'META']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export class IntegrationController {
  constructor(private readonly service: IntegrationService) {}

  summary = async (req: Request, res: Response) => {
    res.status(200).json({ integrations: await this.service.getSummary(req.context.storeId!) });
  };

  syncRuns = async (req: Request, res: Response) => {
    const query = syncRunQuerySchema.parse(req.query);
    res.status(200).json({
      syncRuns: await this.service.listRecentSyncRuns(
        req.context.storeId!,
        query.provider,
        query.limit,
      ),
    });
  };
}
