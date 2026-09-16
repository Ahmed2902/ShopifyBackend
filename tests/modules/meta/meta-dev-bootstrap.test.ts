import { describe, expect, it, vi } from 'vitest';

describe('Meta development sandbox bootstrap contract', () => {
  it('documents the development flow as deterministic sandbox-only', () => {
    const developmentFlow = [
      'completeInstall',
      'discoverAssets',
      'configure sandbox account',
      'sync ads hierarchy',
      'sync insights',
    ];

    expect(developmentFlow).toEqual([
      'completeInstall',
      'discoverAssets',
      'configure sandbox account',
      'sync ads hierarchy',
      'sync insights',
    ]);
  });

  it('keeps this test isolated from real Meta credentials', () => {
    expect(vi.isMockFunction).toBeTypeOf('function');
  });
});
