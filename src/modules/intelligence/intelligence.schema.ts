import { z } from 'zod';

const pagination = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
};

export const recommendationStatusSchema = z.enum([
  'CREATED',
  'VIEWED',
  'ACCEPTED',
  'DISMISSED',
  'RESOLVED',
]);
export const recommendationCategorySchema = z.enum([
  'CAMPAIGN_EFFICIENCY',
  'CREATIVE_FATIGUE',
  'UNDEREXPOSED_PRODUCT',
  'PAID_COMMERCE_MISMATCH',
  'MARGIN_TRAP',
  'INVENTORY_SPEND_CONFLICT',
  'DATA_QUALITY',
]);
export const recommendationSeveritySchema = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export const recommendationEntityTypeSchema = z.enum([
  'STORE',
  'CAMPAIGN',
  'AD_SET',
  'AD',
  'CREATIVE',
  'PRODUCT',
  'VARIANT',
  'COLLECTION',
]);

export const recommendationListQuerySchema = z.object({
  ...pagination,
  status: recommendationStatusSchema.optional(),
  category: recommendationCategorySchema.optional(),
  severity: recommendationSeveritySchema.optional(),
  entityType: recommendationEntityTypeSchema.optional(),
});

export const recommendationParamsSchema = z.object({ id: z.string().uuid() });
export const recommendationStatusUpdateSchema = z.object({
  status: z.enum(['VIEWED', 'ACCEPTED', 'DISMISSED', 'RESOLVED']),
});

export const inventoryModeUpdateSchema = z.object({
  mode: z.enum(['DISABLED', 'TRUSTED', 'UNRELIABLE']),
});

export const dataQualityListQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(200).default(100),
});
