import type { Request, Response } from 'express';
import {
  configureConversionDestinationSchema,
  conversionDeliveryListQuerySchema,
  conversionDeliveryParamsSchema,
  conversionDestinationParamsSchema,
} from './conversion-delivery.schema.js';
import { conversionDeliveryService } from './conversion-delivery.service.js';

export class ConversionDeliveryController {
  destinations = async (req: Request, res: Response) => {
    res.status(200).json(await conversionDeliveryService.listDestinations(req.context.storeId!));
  };

  configureDestination = async (req: Request, res: Response) => {
    const input = configureConversionDestinationSchema.parse(req.body);
    res
      .status(200)
      .json(await conversionDeliveryService.configureDestination(req.context.storeId!, input));
  };

  activateDestination = async (req: Request, res: Response) => {
    const { destinationId } = conversionDestinationParamsSchema.parse(req.params);
    res
      .status(200)
      .json(await conversionDeliveryService.activateDestination(req.context.storeId!, destinationId));
  };

  pauseDestination = async (req: Request, res: Response) => {
    const { destinationId } = conversionDestinationParamsSchema.parse(req.params);
    res
      .status(200)
      .json(await conversionDeliveryService.pauseDestination(req.context.storeId!, destinationId));
  };

  deliveries = async (req: Request, res: Response) => {
    const query = conversionDeliveryListQuerySchema.parse(req.query);
    const result = await conversionDeliveryService.listDeliveries(req.context.storeId!, query);
    res.status(200).json({
      items: result.items,
      pagination: { page: query.page, limit: query.limit, total: result.total },
    });
  };

  retryDelivery = async (req: Request, res: Response) => {
    const { deliveryId } = conversionDeliveryParamsSchema.parse(req.params);
    res
      .status(200)
      .json(await conversionDeliveryService.retryDelivery(req.context.storeId!, deliveryId));
  };
}

export const conversionDeliveryController = new ConversionDeliveryController();
