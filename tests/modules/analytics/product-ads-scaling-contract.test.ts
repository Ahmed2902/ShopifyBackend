import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workspace = readFileSync(
  'src/modules/analytics/product-ads.workspace.ts',
  'utf8',
);

describe('Product × Ads scaling contract', () => {
  it('does not materialize and sort the entire matching product-pair dataset before pagination', () => {
    expect(workspace).toContain('const pageEnd = pageStart + query.limit');
    expect(workspace).toContain('insertRankedPair(ranked, item, pageEnd)');
    expect(workspace).toContain('if (items.length > maxItems) items.pop()');
    expect(workspace).not.toContain('const items = [...ids]');
    expect(workspace).not.toContain('.sort((left, right) => {');
  });

  it('preserves the existing exact ranking order while bounding retained pairs', () => {
    expect(workspace).toContain(
      'right.current.advertising.spend - left.current.advertising.spend',
    );
    expect(workspace).toContain(
      'right.current.commerce.netProductRevenue - left.current.commerce.netProductRevenue',
    );
    expect(workspace).toContain('left.product.title.localeCompare(right.product.title)');
  });
});
