import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { advertisingProviderRegistry } from '../../../src/modules/advertising/advertising.provider.js';
import { billingAdProviderSchema } from '../../../src/modules/billing/billing.schema.js';
import { BUSINESS_KNOWLEDGE_CATALOG } from '../../../src/modules/business-knowledge/business-knowledge.catalog.js';
import { MCP_TOOLS } from '../../../src/modules/mcp/mcp-tools.js';

describe('Google Ads paid-media provider contract', () => {
  it('registers GOOGLE_ADS with truthful PMax and non-additive evidence capabilities', () => {
    expect(advertisingProviderRegistry.supportedProviders()).toContain('GOOGLE_ADS');
    const capabilities = advertisingProviderRegistry.get('GOOGLE_ADS').capabilities();
    expect(capabilities.levels).toEqual(['CAMPAIGN', 'GROUP', 'AD', 'CREATIVE']);
    expect(capabilities.groupKinds).toEqual(['AD_GROUP', 'ASSET_GROUP']);
    expect(capabilities.groupLabel).toBe('Ad Group / Asset Group');
    expect(capabilities.attributionModel).toBe('PROVIDER_REPORTED');
    expect(capabilities.supportsCreativeAnalytics).toBe(false);
    const limitations = capabilities.limitations.join(' ');
    expect(limitations).toMatch(/Performance Max/i);
    expect(limitations).toMatch(/not Shopify revenue truth/i);
    expect(limitations).toMatch(/reach is unavailable/i);
    expect(limitations).toMatch(/selected Google Ads client customer accounts/i);
  });

  it('routes hierarchy and overview reads through the shared canonical metric policy', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/modules/google-ads/google-ads.evidence-provider.ts'),
      'utf8',
    );
    expect(source).toContain('canonicalPaidMediaReadService.overview');
    expect(source).toContain('canonicalPaidMediaReadService.list');
    expect(source).toContain('canonicalPaidMediaReadService.detail');
    expect(source).not.toContain('setUTCHours');
    expect(source).not.toMatch(/level:\s*['"]ACCOUNT['"].*groupBy/s);
  });

  it('publishes truthful creative/asset capability limitations', () => {
    const creative = BUSINESS_KNOWLEDGE_CATALOG.find((entry) => entry.domain === 'CREATIVES');
    expect(creative?.sourceOfTruth).toContain('Google Ads canonical asset entities');
    expect(creative?.caveats.join(' ')).toMatch(/asset-level delivery analytics are not claimed/i);
    expect(creative?.caveats.join(' ')).toMatch(/TikTok normalized creative analytics are not available/i);
  });

  it('accepts Google Ads in the shared V1 ad-channel billing selector', () => {
    expect(billingAdProviderSchema.parse({ provider: 'GOOGLE_ADS' })).toEqual({
      provider: 'GOOGLE_ADS',
    });
  });

  it('exposes GOOGLE_ADS through the shared read-only MCP paid-media tool', () => {
    const tool = MCP_TOOLS.find((candidate) => candidate.name === 'stride_get_paid_media');
    expect(tool).toBeTruthy();
    const schema = tool!.inputSchema as {
      properties?: { provider?: { enum?: string[] }; level?: { enum?: string[] } };
    };
    expect(schema.properties?.provider?.enum).toContain('GOOGLE_ADS');
    expect(schema.properties?.level?.enum).toEqual(['CAMPAIGN', 'GROUP', 'AD', 'CREATIVE']);
    expect(tool!.annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
    });
  });
});
