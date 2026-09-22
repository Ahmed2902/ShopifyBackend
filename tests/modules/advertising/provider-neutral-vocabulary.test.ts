import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const provider = readFileSync('src/modules/advertising/advertising.provider.ts', 'utf8');
const types = readFileSync('src/modules/advertising/advertising.types.ts', 'utf8');
const integrations = readFileSync('src/modules/integrations/integration.schema.ts', 'utf8');
const advisor = readFileSync('src/modules/business-knowledge/advisor-read.service.ts', 'utf8');
const mcp = readFileSync('src/modules/mcp/mcp-tools.ts', 'utf8');

describe('provider-neutral paid-media vocabulary', () => {
  it('uses GROUP at shared application and MCP boundaries while preserving provider group kinds', () => {
    expect(provider).toContain("export type PaidMediaLevel = 'CAMPAIGN' | 'GROUP' | 'AD' | 'CREATIVE'");
    expect(provider).toContain("groupKinds: ['AD_SET']");
    expect(provider).toContain("groupKinds: ['AD_GROUP']");
    expect(types).toContain("'AD_SET' | 'AD_GROUP' | 'ASSET_GROUP'");
    expect(advisor).toContain("| 'GROUP'");
    expect(advisor).not.toContain("| 'AD_SET'");
    expect(mcp).toContain("level: z.enum(['CAMPAIGN', 'GROUP', 'AD', 'CREATIVE'])");
    expect(mcp).not.toContain("level: z.enum(['CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE'])");
  });

  it('keeps Google Ads in the canonical contract without enabling the integration prematurely', () => {
    expect(types).toContain("export type AdvertisingPlatform = 'META' | 'TIKTOK' | 'GOOGLE_ADS'");
    expect(integrations).toContain("export const ADVERTISING_PROVIDERS = ['META', 'TIKTOK'] as const");
    expect(integrations).not.toContain("['META', 'TIKTOK', 'GOOGLE_ADS']");
  });
});
