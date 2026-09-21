import { z } from 'zod';

export const shopifySyncRunParamsSchema = z.object({
  syncRunId: z.string().uuid(),
});
