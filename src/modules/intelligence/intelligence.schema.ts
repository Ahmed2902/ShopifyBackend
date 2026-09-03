import { z } from 'zod';

export const inventoryModeUpdateSchema = z.object({
  mode: z.enum(['DISABLED', 'TRUSTED', 'UNRELIABLE']),
});
