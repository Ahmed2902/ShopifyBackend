import { z } from 'zod';
import {
  PIXEL_EVENT_VERSION,
  PIXEL_MAX_BATCH_SIZE,
  STOREFRONT_CONSENT_STATES,
  STOREFRONT_EVENT_NAMES,
} from './pixel.types.js';

const opaqueIdSchema = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

const externalIdSchema = z.string().trim().min(1).max(128);
const checkoutTokenSchema = z.string().trim().min(1).max(255);
const shopifyOrderExternalIdSchema = z
  .string()
  .trim()
  .max(128)
  .regex(/^gid:\/\/shopify\/Order\/\d+$/);
const providerNumericIdSchema = z.string().trim().regex(/^\d+$/).max(128);
const attributionValueSchema = z.string().trim().min(1).max(255);
const clickIdSchema = z.string().trim().min(1).max(512);
const urlSchema = z.string().url().max(2048);
const collectorTokenSchema = z
  .string()
  .trim()
  .min(40)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const storefrontAttributionSchema = z
  .object({
    utmSource: attributionValueSchema.optional(),
    utmMedium: attributionValueSchema.optional(),
    utmCampaign: attributionValueSchema.optional(),
    utmContent: attributionValueSchema.optional(),
    utmTerm: attributionValueSchema.optional(),
    metaClickId: clickIdSchema.optional(),
    googleClickId: clickIdSchema.optional(),
    tiktokClickId: clickIdSchema.optional(),
    metaCampaignExternalId: providerNumericIdSchema.optional(),
    metaAdSetExternalId: providerNumericIdSchema.optional(),
    metaAdExternalId: providerNumericIdSchema.optional(),
  })
  .strict();

export const storefrontEventSchema = z
  .object({
    eventId: opaqueIdSchema,
    eventVersion: z.literal(PIXEL_EVENT_VERSION).default(PIXEL_EVENT_VERSION),
    eventName: z.enum(STOREFRONT_EVENT_NAMES),
    eventAt: z.string().datetime(),
    anonymousVisitorId: opaqueIdSchema.optional(),
    sessionId: opaqueIdSchema.optional(),
    consentState: z.enum(STOREFRONT_CONSENT_STATES),
    pageUrl: urlSchema.optional(),
    referrerUrl: urlSchema.optional(),
    landingPageUrl: urlSchema.optional(),
    productExternalId: externalIdSchema.optional(),
    variantExternalId: externalIdSchema.optional(),
    collectionExternalId: externalIdSchema.optional(),
    quantity: z.number().int().min(1).max(100_000).optional(),
    shopifyCheckoutToken: checkoutTokenSchema.optional(),
    shopifyOrderExternalId: shopifyOrderExternalIdSchema.optional(),
    attribution: storefrontAttributionSchema.optional(),
  })
  .strict()
  .superRefine((event, ctx) => {
    const hasProductTarget = Boolean(event.productExternalId || event.variantExternalId);
    const isCheckoutEvent =
      event.eventName === 'BEGIN_CHECKOUT' ||
      event.eventName === 'CHECKOUT_PROGRESS' ||
      event.eventName === 'CHECKOUT_COMPLETED';

    if (event.eventName === 'PRODUCT_VIEW' && !hasProductTarget) {
      ctx.addIssue({
        code: 'custom',
        message: 'PRODUCT_VIEW requires productExternalId or variantExternalId',
        path: ['productExternalId'],
      });
    }

    if (event.eventName === 'COLLECTION_VIEW' && !event.collectionExternalId) {
      ctx.addIssue({
        code: 'custom',
        message: 'COLLECTION_VIEW requires collectionExternalId',
        path: ['collectionExternalId'],
      });
    }

    if (
      (event.eventName === 'ADD_TO_CART' || event.eventName === 'REMOVE_FROM_CART') &&
      !hasProductTarget
    ) {
      ctx.addIssue({
        code: 'custom',
        message: `${event.eventName} requires productExternalId or variantExternalId`,
        path: ['productExternalId'],
      });
    }

    if (
      event.quantity !== undefined &&
      event.eventName !== 'ADD_TO_CART' &&
      event.eventName !== 'REMOVE_FROM_CART'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'quantity is only valid for cart mutation events',
        path: ['quantity'],
      });
    }

    if (event.shopifyCheckoutToken && !isCheckoutEvent) {
      ctx.addIssue({
        code: 'custom',
        message: 'shopifyCheckoutToken is only valid for checkout events',
        path: ['shopifyCheckoutToken'],
      });
    }

    if (event.shopifyOrderExternalId && event.eventName !== 'CHECKOUT_COMPLETED') {
      ctx.addIssue({
        code: 'custom',
        message: 'shopifyOrderExternalId is only valid for CHECKOUT_COMPLETED',
        path: ['shopifyOrderExternalId'],
      });
    }
  });

export const pixelIngestBatchSchema = z
  .object({
    installationId: z.string().uuid(),
    collectorToken: collectorTokenSchema,
    events: z.array(storefrontEventSchema).min(1).max(PIXEL_MAX_BATCH_SIZE),
  })
  .strict();

export const pixelDebugBatchSchema = z
  .object({
    events: z.array(storefrontEventSchema).min(1).max(PIXEL_MAX_BATCH_SIZE),
  })
  .strict();

export type StorefrontEventInput = z.infer<typeof storefrontEventSchema>;
export type PixelIngestBatchInput = z.infer<typeof pixelIngestBatchSchema>;
export type PixelDebugBatchInput = z.infer<typeof pixelDebugBatchSchema>;
