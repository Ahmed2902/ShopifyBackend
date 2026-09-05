import type { Request, Response } from 'express';
import { AppError } from '../../errors/app-error.js';
import { pixelDebugBatchSchema, pixelIngestBatchSchema } from './pixel.schema.js';
import { pixelService, type PixelService } from './pixel.service.js';

function parseCollectorBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AppError('Pixel collector body must be valid JSON', 400, 'PIXEL_INVALID_JSON');
  }
}

export class PixelController {
  constructor(private readonly service: PixelService) {}

  ingest = async (req: Request, res: Response) => {
    const input = pixelIngestBatchSchema.parse(parseCollectorBody(req.body));
    res.status(200).json(await this.service.ingest(input));
  };

  status = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.getStatus(req.context.storeId!));
  };

  install = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.installShopifyPixel(req.context.storeId!));
  };

  debugValidate = async (req: Request, res: Response) => {
    const input = pixelDebugBatchSchema.parse(req.body);
    res.status(200).json(this.service.validateDebug(input));
  };
}

export const pixelController = new PixelController(pixelService);
