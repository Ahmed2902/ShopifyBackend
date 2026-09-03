import type { Request, Response } from 'express';
import {
  dataQualityListQuerySchema,
  inventoryModeUpdateSchema,
  recommendationListQuerySchema,
  recommendationParamsSchema,
  recommendationStatusUpdateSchema,
} from './intelligence.schema.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

export class IntelligenceController {
  constructor(private readonly service: IntelligenceService) {}

  evaluate = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.evaluate(req.context.storeId!));
  };

  recommendations = async (req: Request, res: Response) => {
    res.status(200).json(
      await this.service.listRecommendations(
        req.context.storeId!,
        recommendationListQuerySchema.parse(req.query),
      ),
    );
  };

  recommendation = async (req: Request, res: Response) => {
    const { id } = recommendationParamsSchema.parse(req.params);
    res.status(200).json(await this.service.getRecommendation(req.context.storeId!, id));
  };

  updateRecommendationStatus = async (req: Request, res: Response) => {
    const { id } = recommendationParamsSchema.parse(req.params);
    const { status } = recommendationStatusUpdateSchema.parse(req.body);
    res.status(200).json(
      await this.service.setRecommendationStatus(
        req.context.storeId!,
        id,
        status,
        req.context.userId!,
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

  dataQuality = async (req: Request, res: Response) => {
    const { limit } = dataQualityListQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listDataQuality(req.context.storeId!, limit));
  };
}

export const intelligenceController = new IntelligenceController(intelligenceService);
