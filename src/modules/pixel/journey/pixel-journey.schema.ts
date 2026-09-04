import { z } from 'zod';
import { STOREFRONT_JOURNEY_SOURCES } from '../pixel.types.js';

const isoDateTime = z.string().datetime().transform((value) => new Date(value));
const opaqueVisitorId = z
  .string()
  .trim()
  .min(8)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);

export const pixelSessionListQuerySchema = z
  .object({
    page: z.coerce.number().int().positive().default(1),
    limit: z.coerce.number().int().positive().max(100).default(50),
    from: isoDateTime.optional(),
    to: isoDateTime.optional(),
    source: z.enum(STOREFRONT_JOURNEY_SOURCES).optional(),
    metaAdExternalId: z.string().trim().regex(/^\d+$/).max(128).optional(),
    productExternalId: z.string().trim().min(1).max(128).optional(),
    checkoutCompleted: z
      .enum(['true', 'false'])
      .transform((value) => value === 'true')
      .optional(),
  })
  .refine((value) => !value.from || !value.to || value.from <= value.to, {
    message: 'from must be on or before to',
    path: ['from'],
  });

export const pixelSessionParamsSchema = z.object({ sessionId: z.string().uuid() });
export const pixelVisitorParamsSchema = z.object({ anonymousVisitorId: opaqueVisitorId });
export const pixelVisitorJourneyQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(100).default(100),
});
