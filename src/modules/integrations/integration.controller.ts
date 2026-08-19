import type { Request, Response } from 'express';
import {
  integrationStoreParamsSchema,
  syncRunQuerySchema,
} from './integration.schema.js';
import type { IntegrationService } from './integration.service.js';

export class IntegrationController {
  constructor(private readonly service: IntegrationService) {}

  summary = async (req: Request, res: Response) => {
    const { storeId } = integrationStoreParamsSchema.parse(req.params);
    const integrations = await this.service.getSummary(storeId);
    res.status(200).json({ integrations });
  };

  syncRuns = async (req: Request, res: Response) => {
    const { storeId } = integrationStoreParamsSchema.parse(req.params);
    const query = syncRunQuerySchema.parse(req.query);
    const syncRuns = await this.service.listRecentSyncRuns(
      storeId,
      query.provider,
      query.limit,
    );
    res.status(200).json({ syncRuns });
  };
}
