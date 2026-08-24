import type { Request, Response } from 'express';
import { intelligenceQuerySchema } from './intelligence.schema.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

export class IntelligenceController {
  constructor(private readonly service: IntelligenceService) {}

  recommendations = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.getRecommendations(
        req.context.storeId!,
        intelligenceQuerySchema.parse(req.query),
      ),
    );
  };
}

export const intelligenceController = new IntelligenceController(intelligenceService);
