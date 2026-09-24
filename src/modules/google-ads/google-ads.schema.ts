import { z } from 'zod';

export const googleAdsCallbackSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });
export const googleAdsConfigureSchema = z.object({ customerIds: z.array(z.string().min(1)).min(1).max(100) });
export const googleAdsSyncSchema = z.object({ mode: z.enum(['HISTORICAL', 'INCREMENTAL']).default('INCREMENTAL') });
