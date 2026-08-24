import { z } from 'zod';

const pagination = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
};

export const tiktokCatalogParamsSchema = z.object({ catalogId: z.string().min(1) });
export const tiktokCatalogItemsQuerySchema = z.object({ ...pagination });
