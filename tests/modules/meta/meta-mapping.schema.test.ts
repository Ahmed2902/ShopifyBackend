import { describe, expect, it } from 'vitest';
import { metaManualAdTargetSchema } from '../../../src/modules/meta/mapping/meta-mapping.schema.js';

const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const collectionId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('metaManualAdTargetSchema', () => {
  it('accepts exactly one ad target family', () => {
    expect(
      metaManualAdTargetSchema.safeParse({
        mappings: [{ productId, granularity: 'PRODUCT' }],
      }).success,
    ).toBe(true);
    expect(
      metaManualAdTargetSchema.safeParse({
        collectionIds: [collectionId],
      }).success,
    ).toBe(true);
  });

  it('rejects a body that mixes product and collection targets', () => {
    expect(
      metaManualAdTargetSchema.safeParse({
        mappings: [{ productId, granularity: 'PRODUCT' }],
        collectionIds: [collectionId],
      }).success,
    ).toBe(false);
  });
});
