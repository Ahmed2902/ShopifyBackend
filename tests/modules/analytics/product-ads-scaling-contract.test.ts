import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const legacyWorkspace = readFileSync(
  'src/modules/analytics/product-ads.workspace.ts',
  'utf8',
);
const unifiedRepository = readFileSync(
  'src/modules/analytics/unified-product-ads.repository.ts',
  'utf8',
);

describe('Product × Ads scaling contract', () => {
  it('keeps the legacy endpoint as a compatibility adapter over the authoritative unified engine', () => {
    expect(legacyWorkspace).toContain('UnifiedProductAdsService');
    expect(legacyWorkspace).toContain('this.unifiedService.list(');
    expect(legacyWorkspace).toContain('this.unifiedService.detail(');
    expect(legacyWorkspace).toContain("computation: 'UNIFIED_PRODUCT_ADS_SERVICE'");

    // The retired legacy engine must not reintroduce broad full-universe reads or its own ranking loop.
    expect(legacyWorkspace).not.toContain('getCommerceRows');
    expect(legacyWorkspace).not.toContain('getMetaRows');
    expect(legacyWorkspace).not.toContain('getVariantCosts');
    expect(legacyWorkspace).not.toContain('getActiveMappings');
    expect(legacyWorkspace).not.toContain('buildProductAdsPeriod');
    expect(legacyWorkspace).not.toContain('insertRankedPair');
  });

  it('keeps candidate ranking and pagination inside the shared PostgreSQL path', () => {
    expect(unifiedRepository).toContain('async rankedProductCandidates');
    expect(unifiedRepository).toContain('COUNT(*) OVER() AS total_count');
    expect(unifiedRepository).toContain(
      'ORDER BY candidate.spend DESC NULLS LAST, candidate.net_revenue DESC NULLS LAST, candidate.title ASC, candidate.product_id ASC',
    );
    expect(unifiedRepository).toContain('LIMIT ${limit} OFFSET ${offset}');

    // Page/detail enrichment stays bounded to the product IDs returned by the ranked candidate query.
    expect(unifiedRepository).toContain('productId: { in: productIds }');
    expect(unifiedRepository).toContain('activeMappings(');
  });
});
