import type { Request, Response } from 'express';
import { billingPlanSchema, billingReadQuerySchema } from './billing.schema.js';
import { billingService, type BillingService } from './billing.service.js';

export class BillingController {
  constructor(private readonly service: BillingService) {}

  read = async (req: Request, res: Response) => {
    const { fresh } = billingReadQuerySchema.parse(req.query);
    res.status(200).json(
      await this.service.read(req.context.storeId!, new Date(), {
        fresh,
        failOnVerificationError: fresh,
      }),
    );
  };

  portal = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.portal(req.context.storeId!));
  };

  refresh = async (req: Request, res: Response) => {
    res.status(200).json(await this.service.refreshFromShopify(req.context.storeId!));
  };

  selectPlan = async (req: Request, res: Response) => {
    const { plan } = billingPlanSchema.parse(req.body);
    res.status(200).json(await this.service.selectPlan(req.context.storeId!, plan));
  };
}

export const billingController = new BillingController(billingService);
