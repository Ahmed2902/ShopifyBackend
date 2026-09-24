import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUSINESS_KNOWLEDGE_CATALOG } from '../../../src/modules/business-knowledge/business-knowledge.catalog.js';

describe('unified production correctness repair', () => {
  it('keeps unified Product x Ads attribution fail-closed for incomplete provider facts', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/modules/analytics/unified-product-ads.repository.ts'),
      'utf8',
    );
    expect(source).toContain('_count: { _all: true, conversions: true, conversionValue: true }');
    expect(source).toContain('incompleteConversionCurrencies');
    expect(source).toContain('incompleteValueCurrencies');
    expect(source).not.toMatch(/conversions:\s*decimal\([^\n]+\)\s*\?\?\s*0/);
    expect(source).not.toMatch(/conversionValue:\s*decimal\([^\n]+\)\s*\?\?\s*0/);
  });

  it('publishes provider creative capability limits without inventing TikTok or Google delivery evidence', () => {
    const creative = BUSINESS_KNOWLEDGE_CATALOG.find((entry) => entry.domain === 'CREATIVES');
    const caveats = creative?.caveats.join(' ') ?? '';
    expect(caveats).toMatch(/TikTok normalized creative analytics are not available/i);
    expect(caveats).toMatch(/Google Ads asset entities are available/i);
    expect(caveats).toMatch(/asset-level delivery analytics are not claimed/i);
  });
});
