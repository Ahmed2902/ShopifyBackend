import type { Request, Response } from 'express';
import { CachedReadCoordinator, RedisJsonCache } from '../../lib/redis-json-cache.js';
import {
  intelligenceReadQuerySchema,
  inventoryModeUpdateSchema,
} from './intelligence.schema.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

const SNAPSHOT_CACHE_TTL_SECONDS = 30;
const snapshotReads = new CachedReadCoordinator(
  new RedisJsonCache('intelligence:snapshot:v1', SNAPSHOT_CACHE_TTL_SECONDS),
  250,
);

export class IntelligenceController {
  constructor(private readonly service: IntelligenceService) {}

  snapshot = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { fresh } = intelligenceReadQuerySchema.parse(req.query);
    res.status(200).json(
      await snapshotReads.run(
        storeId,
        () => this.service.snapshot(storeId),
        { fresh },
      ),
    );
  };

  settings = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getSettings(req.context.storeId!));
  };

  updateInventoryMode = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { mode } = inventoryModeUpdateSchema.parse(req.body);
    const result = await this.service.updateInventoryMode(storeId, mode);
    await snapshotReads.invalidate(storeId);
    res.status(200).json(result);
  };
}

export const intelligenceController = new IntelligenceController(intelligenceService);
