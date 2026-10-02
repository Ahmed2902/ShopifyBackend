import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  managedConversionSetupService,
  type ManagedConversionSetupService,
} from './managed-conversion-setup.service.js';

const providerSchema = z.enum(['META', 'TIKTOK', 'GOOGLE_ADS']);
const optionsQuerySchema = z.object({ provider: providerSchema });
const enableSchema = z.object({
  provider: providerSchema,
  optionId: z.string().trim().min(1).max(255),
});

export class ManagedConversionSetupController {
  constructor(private readonly service: ManagedConversionSetupService) {}

  options = async (req: Request, res: Response) => {
    const { provider } = optionsQuerySchema.parse(req.query);
    res.status(200).json(await this.service.options(req.context.storeId!, provider));
  };

  enable = async (req: Request, res: Response) => {
    const { provider, optionId } = enableSchema.parse(req.body);
    res.status(200).json(await this.service.enable(req.context.storeId!, provider, optionId));
  };
}

export const managedConversionSetupController = new ManagedConversionSetupController(
  managedConversionSetupService,
);
