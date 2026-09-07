import type { Request, Response } from 'express';
import { InFlightCoalescer } from '../../lib/in-flight-coalescer.js';
import { inventoryModeUpdateSchema } from './intelligence.schema.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

const snapshotInFlight = new InFlightCoalescer(250);

export class IntelligenceController {
  constructor(private readonly service: IntelligenceService) {}

  snapshot = async (req: Request, res: Response) => {
    const storeId = req.context.storeId!;
    res.status(200).json(
      await snapshotInFlight.run(`intelligence:snapshot:${storeId}`, () =>
        this.service.snapshot(storeId),
      ),
    );
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
