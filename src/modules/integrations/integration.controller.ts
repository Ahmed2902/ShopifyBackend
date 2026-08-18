import type { Request, Response } from 'express';
import { getAuthUserId } from '../../middleware/auth.middleware.js';
import {
  integrationStoreParamsSchema,
  syncRunQuerySchema,
} from './integration.schema.js';
import { IntegrationService } from './integration.service.js';

export class IntegrationController {
  constructor(private readonly service: IntegrationService) {}

  summary = async (req: Request, res: Response) => {
    const { storeId } = integrationStoreParamsSchema.parse(req.params);
    const integrations = await this.service.getSummary(getAuthUserId(res), storeId);
    res.status(200).json({ integrations });
  };

  syncRuns = async (req: Request, res: Response) => {
    const { storeId } = integrationStoreParamsSchema.parse(req.params);
    const query = syncRunQuerySchema.parse(req.query);
    const syncRuns = await this.service.listRecentSyncRuns(
      getAuthUserId(res),
      storeId,
      query.provider,
      query.limit,
    );
    res.status(200).json({ syncRuns });
  };
}
