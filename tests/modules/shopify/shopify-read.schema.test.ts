import { describe, expect, it } from 'vitest';
import {
  shopifyInventoryQuerySchema,
  shopifyOrdersQuerySchema,
  shopifyProductsQuerySchema,
} from '../../../src/modules/shopify/read/shopify-read.schema.js';

describe('Shopify read query schemas', () => {
  it('applies stable pagination defaults', () => {
    expect(shopifyProductsQuerySchema.parse({})).toEqual({ page: 1, limit: 50 });
  });

  it('coerces pagination and inventory thresholds from query strings', () => {
    expect(
      shopifyInventoryQuerySchema.parse({ page: '2', limit: '25', lowStockBelow: '7' }),
    ).toMatchObject({ page: 2, limit: 25, lowStockBelow: 7 });
  });

  it('rejects pagination beyond the public API limit', () => {
    expect(() => shopifyProductsQuerySchema.parse({ limit: '101' })).toThrow();
  });

  it('parses the test-order filter without truthy string mistakes', () => {
    expect(shopifyOrdersQuerySchema.parse({ isTest: 'true' }).isTest).toBe(true);
    expect(shopifyOrdersQuerySchema.parse({ isTest: 'false' }).isTest).toBe(false);
  });

  it('rejects unsupported boolean spellings', () => {
    expect(() => shopifyOrdersQuerySchema.parse({ isTest: '1' })).toThrow();
  });

  it('accepts an inclusive chronological order range', () => {
    const query = shopifyOrdersQuerySchema.parse({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-21T00:00:00.000Z',
    });
    expect(query.from).toBe('2026-08-01T00:00:00.000Z');
  });

  it('rejects an inverted order range', () => {
    expect(() =>
      shopifyOrdersQuerySchema.parse({
        from: '2026-08-22T00:00:00.000Z',
        to: '2026-08-21T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects invalid location identifiers', () => {
    expect(() => shopifyInventoryQuerySchema.parse({ locationId: 'not-a-uuid' })).toThrow();
  });
});
