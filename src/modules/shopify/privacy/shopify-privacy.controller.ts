import type { Request, Response } from 'express';
import { z } from 'zod';
import { shopifyPrivacyService, type ShopifyPrivacyService } from './shopify-privacy.service.js';

const requestParamsSchema = z.object({ requestId: z.string().uuid() });

function noStore(res: Response): void {
  res.set('Cache-Control', 'no-store, private');
  res.set('Pragma', 'no-cache');
}

export class ShopifyPrivacyController {
  constructor(private readonly service: ShopifyPrivacyService) {}

  listDataRequests = async (req: Request, res: Response) => {
    const requests = await this.service.listDataRequests(req.context.storeId!);
    noStore(res);
    res.status(200).json({ requests });
  };

  getDataRequest = async (req: Request, res: Response) => {
    const { requestId } = requestParamsSchema.parse(req.params);
    const request = await this.service.getDataRequest(req.context.storeId!, requestId);
    noStore(res);
    res.status(200).json({ request });
  };
}

export const shopifyPrivacyController = new ShopifyPrivacyController(shopifyPrivacyService);
