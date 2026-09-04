import type { Request, Response } from 'express';
import { inventoryModeUpdateSchema } from './intelligence.schema.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

export class IntelligenceController {
  constructor(private readonly service: IntelligenceService) {}

  snapshot = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.snapshot(req.context.storeId!));
  };

  settings = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getSettings(req.context.storeId!));
  };

  updateInventoryMode = async (req: Request, res: Response) => {
    const { mode } = inventoryModeUpdateSchema.parse(req.body);
    res.status(200).json(await this.service.updateInventoryMode(req.context.storeId!, mode));
  };
}

export const intelligenceController = new IntelligenceController(intelligenceService);
