import { z } from 'zod';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const dateSchema = z.string().refine(validDate, 'Expected a valid YYYY-MM-DD date');
const adAccountIdSchema = z.string().trim().min(1).max(255);

export const analyticsReadControlSchema = z.object({
  fresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const analyticsRangeQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .refine((value) => Boolean(value.from) === Boolean(value.to), {
    message: 'from and to must be provided together',
  });

export const analyticsListQuerySchema = analyticsRangeQuerySchema.and(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
);

export const advertisingRangeQuerySchema = analyticsRangeQuerySchema.and(
  z.object({ adAccountId: adAccountIdSchema.optional() }),
);

export const advertisingListQuerySchema = analyticsListQuerySchema.and(
  z.object({ adAccountId: adAccountIdSchema.optional() }),
);

export const analyticsEntityParamsSchema = z.object({
  entityId: z.string().uuid(),
});

export type AnalyticsRangeQuery = z.infer<typeof analyticsRangeQuerySchema>;
export type AnalyticsListQuery = z.infer<typeof analyticsListQuerySchema>;
export type AdvertisingRangeQuery = z.infer<typeof advertisingRangeQuerySchema>;
export type AdvertisingListQuery = z.infer<typeof advertisingListQuerySchema>;
