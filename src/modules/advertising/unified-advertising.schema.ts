import { z } from 'zod';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const dateSchema = z.string().refine(validDate, 'Expected a valid YYYY-MM-DD date');

export const unifiedAdvertisingProviderSchema = z.enum([
  'ALL',
  'META',
  'TIKTOK',
  'GOOGLE_ADS',
]);

export const unifiedAdvertisingRangeQuerySchema = z
  .object({
    from: dateSchema.optional(),
    to: dateSchema.optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
    provider: unifiedAdvertisingProviderSchema.default('ALL'),
    accountId: z.string().uuid().optional(),
    currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  })
  .refine((value) => Boolean(value.from) === Boolean(value.to), {
    message: 'from and to must be provided together',
  });

export const unifiedAdvertisingListQuerySchema = unifiedAdvertisingRangeQuerySchema.and(
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(50),
  }),
);

export type UnifiedAdvertisingRangeQuery = z.infer<typeof unifiedAdvertisingRangeQuerySchema>;
export type UnifiedAdvertisingListQuery = z.infer<typeof unifiedAdvertisingListQuerySchema>;
export type UnifiedAdvertisingProviderFilter = z.infer<typeof unifiedAdvertisingProviderSchema>;
