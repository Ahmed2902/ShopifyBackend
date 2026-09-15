import type { Request, Response } from 'express';
import {
  metaManualAdTargetSchema,
  metaManualCatalogMappingSchema,
  metaMappingAdParamsSchema,
  metaMappingCatalogItemParamsSchema,
  metaMappingListQuerySchema,
} from './meta-mapping.schema.js';
import { findSelectedMetaAdMapping } from './meta-mapping.lookup.js';
import { metaMappingService, type MetaMappingService } from './meta-mapping.service.js';

export class MetaMappingController {
  constructor(private readonly service: MetaMappingService) {}

  resolve = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.resolveStoreMappings(req.context.storeId!));
  };

  summary = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.mappingSummary(req.context.storeId!));
  };

  ads = async (req: Request, res: Response) => {
    const { page, limit } = metaMappingListQuerySchema.parse(req.query);
    res.status(200).json(await this.service.listAdMappings(req.context.storeId!, page, limit));
  };

  ad = async (req: Request, res: Response) => {
    const { adId } = metaMappingAdParamsSchema.parse(req.params);
    res.status(200).json(
      await findSelectedMetaAdMapping(this.service, req.context.storeId!, adId),
    );
  };

  suggestions = async (req: Request, res: Response) => {
    const { adId } = metaMappingAdParamsSchema.parse(req.params);
    res.status(200).json(await this.service.suggestions(req.context.storeId!, adId));
  };

  replaceAd = async (req: Request, res: Response) => {
    const { adId } = metaMappingAdParamsSchema.parse(req.params);
    const target = metaManualAdTargetSchema.parse(req.body);
    res.status(200).json(
      'mappings' in target
        ? await this.service.replaceManualAdMappings(req.context.storeId!, adId, target.mappings)
        : await this.service.replaceManualCollectionMappings(
            req.context.storeId!,
            adId,
            target.collectionIds,
          ),
    );
  };

  confirmAd = async (req: Request, res: Response) => {
    const { adId } = metaMappingAdParamsSchema.parse(req.params);
    res.status(200).json(await this.service.confirmCurrentAdMappings(req.context.storeId!, adId));
  };

  replaceCatalogItem = async (req: Request, res: Response) => {
    const { itemId } = metaMappingCatalogItemParamsSchema.parse(req.params);
    const { variantIds } = metaManualCatalogMappingSchema.parse(req.body);
    res.status(200).json(
      await this.service.replaceManualCatalogMappings(req.context.storeId!, itemId, variantIds),
    );
  };
}

export const metaMappingController = new MetaMappingController(metaMappingService);
