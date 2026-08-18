import { z } from 'zod';

export const storeParamsSchema = z.object({
  storeId: z.string().uuid(),
});

export type StoreParams = z.infer<typeof storeParamsSchema>;
