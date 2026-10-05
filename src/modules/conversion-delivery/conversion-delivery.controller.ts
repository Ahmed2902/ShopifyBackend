import { customerOrderJourney } from './customer-journey.js';
import { conversionSignalHealth, acquisitionAnalytics } from './signal-diagnostics.js';
import { prisma } from '../../lib/prisma.js';
import { billingService } from '../billing/billing.service.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import type { Request, Response } from 'express';
import { z } from 'zod';
import {
  conversionDeliveryService,
  type ConversionDeliveryService,
} from './conversion-delivery.service.js';

const providerSchema = z.enum(['META', 'TIKTOK', 'GOOGLE_ADS']);
const deliveryStatusSchema = z.enum([
  'PENDING',
  'PROCESSING',
  'RETRY',
  'DELIVERED',
  'DEAD',
  'SKIPPED',
]);

const configureDestinationSchema = z
  .object({
    provider: providerSchema,
    externalId: z.string().trim().min(1).max(255),
    displayName: z.string().trim().min(1).max(255).nullable().optional(),
    accessToken: z.string().trim().min(8).max(4096).nullable().optional(),
    testEventCode: z.string().trim().min(1).max(255).optional(),
    customerId: z
      .string()
      .regex(/^\d{10}$/)
      .optional(),
    loginCustomerId: z
      .string()
      .regex(/^\d{10}$/)
      .optional(),
    googleConsentMode: z.enum(['ACCOUNT_DEFAULT', 'GRANTED']).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.provider === 'GOOGLE_ADS') {
      if (!value.customerId) {
        ctx.addIssue({
          code: 'custom',
          path: ['customerId'],
          message: 'customerId is required for Google Ads',
        });
      }
      if (!/^\d+$/.test(value.externalId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['externalId'],
          message: 'Google conversion action ID must be numeric',
        });
      }
      return;
    }
    if (!value.accessToken) {
      ctx.addIssue({
        code: 'custom',
        path: ['accessToken'],
        message: 'Events API access token is required',
      });
    }
  });

const deliveriesQuerySchema = z.object({
  provider: providerSchema.optional(),
  status: deliveryStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

export class ConversionDeliveryController {
  constructor(private readonly service: ConversionDeliveryService) {}

  customerJourney = async (req: Request, res: Response) => {
    res.json(
      await customerOrderJourney(req.context.storeId!, z.string().uuid().parse(req.params.orderId)),
    );
  };
  signalHealth = async (req: Request, res: Response) => {
    res.json(await conversionSignalHealth(req.context.storeId!));
  };
  acquisition = async (req: Request, res: Response) => {
    res.json(await acquisitionAnalytics(req.context.storeId!));
  };
  updateSignals = async (req: Request, res: Response) => {
    const id = z.string().uuid().parse(req.params.destinationId);
    const input = z
      .object({
        enhancedMatching: z.boolean(),
        funnelEvents: z.boolean(),
        browserEvents: z.boolean().optional(),
        overlapPolicy: z.enum(['UNCONFIRMED', 'OTHER_TRACKER', 'STRIDE_EXCLUSIVE']).optional(),
        catalogId: z.string().uuid().nullable().optional(),
      })
      .strict()
      .parse(req.body);
    if (input.enhancedMatching && !env.SHOPIFY_ENHANCED_MATCHING_APPROVED)
      throw new AppError(
        'Customer matching requires Shopify protected customer data approval',
        409,
        'SHOPIFY_MATCHING_APPROVAL_REQUIRED',
      );
    const dest = await prisma.conversionDestination.findFirst({
      where: { id, storeId: req.context.storeId! },
    });
    if (!dest)
      throw new AppError(
        'Conversion destination not found',
        404,
        'CONVERSION_DESTINATION_NOT_FOUND',
      );
    await billingService.requireAdProvider(req.context.storeId!, dest.provider);
    const current = (dest.configJson as Record<string, unknown> | null) ?? {};
    const browserEvents = input.browserEvents ?? current.browserEvents === true;
    const overlapPolicy = input.overlapPolicy ?? current.overlapPolicy ?? 'UNCONFIRMED';
    if (
      browserEvents &&
      (dest.provider !== 'META' || !input.funnelEvents || overlapPolicy !== 'STRIDE_EXCLUSIVE')
    )
      throw new AppError(
        'Paired browser sharing requires Meta funnel sharing and exclusive tracking confirmation',
        400,
        'BROWSER_TRACKING_POLICY_REQUIRED',
      );
    if (input.catalogId) {
      const catalog =
        dest.provider === 'META'
          ? await prisma.metaProductCatalog.findFirst({
              where: {
                id: input.catalogId,
                storeId: req.context.storeId!,
                connection: { status: 'ACTIVE' },
              },
              select: { id: true },
            })
          : dest.provider === 'TIKTOK'
            ? await prisma.tikTokCatalog.findFirst({
                where: {
                  id: input.catalogId,
                  storeId: req.context.storeId!,
                  connection: { status: 'ACTIVE' },
                },
                select: { id: true },
              })
            : null;
      if (!catalog)
        throw new AppError(
          'Choose an available catalog from this store and channel',
          400,
          'CONVERSION_CATALOG_NOT_ACCESSIBLE',
        );
    }
    if (dest.provider === 'GOOGLE_ADS' && input.funnelEvents)
      throw new AppError(
        'Google Ads requires explicitly configured conversion actions',
        400,
        'GOOGLE_FUNNEL_UNSUPPORTED',
      );
    await prisma.conversionDestination.updateMany({
      where: { id, storeId: req.context.storeId! },
      data: {
        configJson: { ...((dest.configJson as Record<string, unknown>) ?? {}), ...input } as never,
      },
    });
    res.json({ updated: true });
  };
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
    res
      .status(200)
      .json(await this.service.disableDestination(req.context.storeId!, destinationId));
  };

  deliveries = async (req: Request, res: Response) => {
    const query = deliveriesQuerySchema.parse(req.query);
    res.status(200).json({
      items: await this.service.listDeliveries(req.context.storeId!, query),
    });
  };
}

export const conversionDeliveryController = new ConversionDeliveryController(
  conversionDeliveryService,
);
