import type { Request, Response } from 'express';
import { z } from 'zod';
import { conversionDeliveryService, type ConversionDeliveryService } from './conversion-delivery.service.js';

const providerSchema = z.enum(['META', 'TIKTOK', 'GOOGLE_ADS']);
const deliveryStatusSchema = z.enum(['PENDING', 'PROCESSING', 'RETRY', 'DELIVERED', 'DEAD', 'SKIPPED']);

const configureDestinationSchema = z
  .object({
    provider: providerSchema,
    externalId: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(255).nullable().optional(),
    accessToken: z.string().trim().min(8).max(4096).nullable().optional(),
    testEventCode: z.string().trim().min(1).max(255).optional(),
    customerId: z.string().regex(/^\d{10}$/).optional(),
    loginCustomerId: z.string().regex(/^\d{10}$/).optional(),
    googleConsentMode: z.enum(['ACCOUNT_DEFAULT', 'GRANTED']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider === 'GOOGLE_ADS') {
      if (!value.customerId) {
        ctx.addIssue({ code: 'custom', path: ['customerId'], message: 'customerId is required for Google Ads' });
      }
      if (!/^\d+$/.test(value.externalId)) {
        ctx.addIssue({ code: 'custom', path: ['externalId'], message: 'Google conversion action ID must be numeric' });
      }
      return;
    }
    if (!value.accessToken) {
      ctx.addIssue({ code: 'custom', path: ['accessToken'], message: 'Events API access token is required' });
    }
  });

const deliveriesQuerySchema = z.object({
  provider: providerSchema.optional(),
  status: deliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export class ConversionDeliveryController {
  constructor(private readonly service: ConversionDeliveryService) {}

  destinations = async (req: Request, res: Response) => {
    res.status(200).json({ items: await this.service.listDestinations(req.context.storeId!) });
  };

  configure = async (req: Request, res: Response) => {
    const input = configureDestinationSchema.parse(req.body);
    const destination = await this.service.configureDestination(req.context.storeId!, {
      provider: input.provider,
      externalId: input.externalId,
      displayName: input.displayName,
      accessToken: input.accessToken,
      config: {
        ...(input.testEventCode ? { testEventCode: input.testEventCode } : {}),
        ...(input.customerId ? { customerId: input.customerId } : {}),
        ...(input.loginCustomerId ? { loginCustomerId: input.loginCustomerId } : {}),
        ...(input.googleConsentMode ? { googleConsentMode: input.googleConsentMode } : {}),
      },
    });
    res.status(200).json(destination);
  };

  disable = async (req: Request, res: Response) => {
    const destinationId = z.string().uuid().parse(req.params.destinationId);
    res.status(200).json(await this.service.disableDestination(req.context.storeId!, destinationId));
  };

  deliveries = async (req: Request, res: Response) => {
    const query = deliveriesQuerySchema.parse(req.query);
    res.status(200).json({
      items: await this.service.listDeliveries(req.context.storeId!, query),
    });
  };
}

export const conversionDeliveryController = new ConversionDeliveryController(conversionDeliveryService);
