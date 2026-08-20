import { z } from 'zod';

const bulkUserErrorSchema = z.object({
  field: z.array(z.string()).nullable().optional(),
  message: z.string(),
});

export const bulkOperationStartSchema = z.object({
  bulkOperationRunQuery: z.object({
    bulkOperation: z
      .object({
        id: z.string().min(1),
        status: z.string().min(1),
      })
      .nullable(),
    userErrors: z.array(bulkUserErrorSchema),
  }),
});

export const bulkOperationStatusSchema = z.object({
  bulkOperation: z
    .object({
      id: z.string().min(1),
      status: z.string().min(1),
      errorCode: z.string().nullable().optional(),
      objectCount: z.union([z.string(), z.number()]).nullable().optional(),
      url: z.string().url().nullable().optional(),
      partialDataUrl: z.string().url().nullable().optional(),
    })
    .nullable(),
});

export type ShopifyBulkOperationStatus = z.infer<
  typeof bulkOperationStatusSchema
>['bulkOperation'];
