import type { Request, Response } from 'express';
import {
  tiktokManualAdMappingSchema,
  tiktokManualCatalogMappingSchema,
  tiktokMappingAdParamsSchema,
  tiktokMappingCatalogItemParamsSchema,
} from './tiktok-mapping.schema.js';
import { tiktokMappingService, type TikTokMappingService } from './tiktok-mapping.service.js';

export class TikTokMappingController {
  constructor(private readonly service: TikTokMappingService) {}

  resolve = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.resolveMappings(req.context.storeId!));
  };

  replaceAd = async (req: Request, res: Response) => {
    const { adId } = tiktokMappingAdParamsSchema.parse(req.params);
    const input = tiktokManualAdMappingSchema.parse(req.body);
    res.status(200).json(
      await this.service.setManualAdMapping(
        req.context.storeId!,
        adId,
        input.productId,
        input.variantId ?? null,
      ),
    );
  };

  replaceCatalogItem = async (req: Request, res: Response) => {
    const { catalogItemId } = tiktokMappingCatalogItemParamsSchema.parse(req.params);
    const { variantId } = tiktokManualCatalogMappingSchema.parse(req.body);
    res.status(200).json(
      await this.service.setManualCatalogMapping(req.context.storeId!, catalogItemId, variantId),
    );
  };
}

export const tiktokMappingController = new TikTokMappingController(tiktokMappingService);
