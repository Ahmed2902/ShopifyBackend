import type { Request, Response } from 'express';
import {
  intelligenceReadQuerySchema,
  inventoryModeUpdateSchema,
} from './intelligence.schema.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from './intelligence-snapshot.read.service.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

export class IntelligenceController {
  constructor(
    private readonly service: IntelligenceService,
    private readonly snapshotReads: IntelligenceSnapshotReadService,
  ) {}

  snapshot = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { fresh } = intelligenceReadQuerySchema.parse(req.query);
    res.status(200).json(await this.snapshotReads.read(storeId, { fresh }));
  };

  settings = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getSettings(req.context.storeId!));
  };

  updateInventoryMode = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    const { mode } = inventoryModeUpdateSchema.parse(req.body);
    const result = await this.service.updateInventoryMode(storeId, mode);
    await this.snapshotReads.invalidate(storeId);
    res.status(200).json(result);
  };
}

export const intelligenceController = new IntelligenceController(
  intelligenceService,
  intelligenceSnapshotReadService,
);
