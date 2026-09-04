import { z } from 'zod';

export const metaMappingListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
});

export const metaMappingAdParamsSchema = z.object({
  adId: z.string().min(1),
});

export const metaMappingCatalogItemParamsSchema = z.object({
  itemId: z.string().min(1),
});

const optionSelectorSchema = z
  .record(z.string().min(1), z.array(z.string().min(1)).min(1).max(20))
  .refine((selector) => Object.keys(selector).length > 0, 'At least one option is required');

const manualMappingSchema = z
  .object({
    productId: z.string().uuid(),
    variantId: z.string().uuid().nullable().optional(),
    granularity: z.enum(['PRODUCT', 'PRODUCT_OPTION', 'VARIANT']),
    optionSelector: optionSelectorSchema.nullable().optional(),
  })
  .superRefine((mapping, ctx) => {
    if (mapping.granularity === 'VARIANT' && !mapping.variantId) {
      ctx.addIssue({
        code: 'custom',
        path: ['variantId'],
        message: 'variantId is required for VARIANT mappings',
      });
    }
    if (mapping.granularity === 'PRODUCT_OPTION' && !mapping.optionSelector) {
      ctx.addIssue({
        code: 'custom',
        path: ['optionSelector'],
        message: 'optionSelector is required for PRODUCT_OPTION mappings',
      });
    }
    if (mapping.granularity === 'PRODUCT' && (mapping.variantId || mapping.optionSelector)) {
      ctx.addIssue({
        code: 'custom',
        message: 'PRODUCT mappings cannot include variantId or optionSelector',
      });
    }
  });

const manualProductTargetSchema = z
  .object({
    mappings: z.array(manualMappingSchema).min(1).max(20),
  })
  .strict();

const manualCollectionTargetSchema = z
  .object({
    collectionIds: z
      .array(z.string().uuid())
      .min(1)
      .max(20)
      .refine((values) => new Set(values).size === values.length, 'collectionIds must be unique'),
  })
  .strict();

export const metaManualAdTargetSchema = z.union([
  manualProductTargetSchema,
  manualCollectionTargetSchema,
]);

// Compatibility export for callers/tests that still validate product-only bodies directly.
export const metaManualAdMappingsSchema = manualProductTargetSchema;

export const metaManualCatalogMappingSchema = z.object({
  variantIds: z
    .array(z.string().uuid())
    .min(1)
    .max(100)
    .refine((values) => new Set(values).size === values.length, 'variantIds must be unique'),
});
