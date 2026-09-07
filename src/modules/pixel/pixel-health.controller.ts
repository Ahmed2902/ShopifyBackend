import type { Request, Response } from 'express';
import { pixelHealthService, type PixelHealthService } from './pixel-health.service.js';

export class PixelHealthController {
  constructor(private readonly service: PixelHealthService = pixelHealthService) {}

  read = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.read(req.context.storeId!));
  };
}

export const pixelHealthController = new PixelHealthController();
