import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_PROVIDERS,
  syncRunQuerySchema,
} from '../../../src/modules/integrations/integration.schema.js';

describe('integration provider schema', () => {
  it('includes TikTok as a first-class integration provider', () => {
    expect(INTEGRATION_PROVIDERS).toContain('TIKTOK');
    expect(syncRunQuerySchema.parse({ provider: 'TIKTOK' })).toEqual({
      provider: 'TIKTOK',
      limit: 25,
    });
  });

  it('rejects unknown providers', () => {
    expect(() => syncRunQuerySchema.parse({ provider: 'GOOGLE_ADS' })).toThrow();
  });
});
