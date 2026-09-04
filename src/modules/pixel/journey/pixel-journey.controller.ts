import type { Request, Response } from 'express';
import {
  pixelSessionListQuerySchema,
  pixelSessionParamsSchema,
  pixelVisitorJourneyQuerySchema,
  pixelVisitorParamsSchema,
} from './pixel-journey.schema.js';
import { pixelJourneyService, type PixelJourneyService } from './pixel-journey.service.js';

export class PixelJourneyController {
  constructor(private readonly service: PixelJourneyService = pixelJourneyService) {}

  sessions = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listSessions(
        req.context.storeId!,
        pixelSessionListQuerySchema.parse(req.query),
      ),
    );
  };

  session = async (req: Request, res: Response) => {
    const { sessionId } = pixelSessionParamsSchema.parse(req.params);
    res.status(200).json(await this.service.getSession(req.context.storeId!, sessionId));
  };

  visitorJourney = async (req: Request, res: Response) => {
    const { anonymousVisitorId } = pixelVisitorParamsSchema.parse(req.params);
    const { limit } = pixelVisitorJourneyQuerySchema.parse(req.query);
    res
      .status(200)
      .json(await this.service.getVisitorJourney(req.context.storeId!, anonymousVisitorId, limit));
  };
}

export const pixelJourneyController = new PixelJourneyController();
