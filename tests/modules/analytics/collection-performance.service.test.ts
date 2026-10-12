import { describe, expect, it, vi } from 'vitest';
import { CommerceAnalyticsService } from '../../../src/modules/analytics/commerce-analytics.service.js';
import type { AnalyticsRepository } from '../../../src/modules/analytics/analytics.repository.js';
import { resolveAnalyticsWindows } from '../../../src/modules/analytics/analytics.dates.js';
const store = { id: 'store-a', currencyCode: 'USD', ianaTimezone: 'Africa/Cairo' } as never;
const windows = resolveAnalyticsWindows({ days: 1, from: '2026-10-12', to: '2026-10-12' }, 'Africa/Cairo');
function line(id: string, date: string, amount: number, currency = 'USD') {
  return { productId: 'product-a', product: { id: 'product-a', title: 'Tee' }, quantity: 2, discountedTotal: amount,
    refundLines: [{ quantity: 1, subtotal: 5 }], order: { id, processedAt: new Date(date), shopifyCreatedAt: new Date(date), currencyCode: currency } };
}
function setup(rows: unknown[] = []) {
  const repository = {
    getCollection: vi.fn().mockResolvedValue({ id: 'collection-a', title: 'Hydrogen', products: [{ productId: 'product-a' }] }),
    getCommerceRows: vi.fn().mockResolvedValue(rows),
  };
  return { repository, service: new CommerceAnalyticsService(repository as unknown as AnalyticsRepository) };
}
describe('collection performance', () => {
  it('uses selected collection membership and store-local dates, excludes foreign currency, and nets refunds', async () => {
    const { repository, service } = setup([line('same-order', '2026-10-11T22:00:00Z', 25), line('same-order', '2026-10-11T22:00:00Z', 15), line('foreign', '2026-10-12T01:00:00Z', 999, 'EUR'), line('previous', '2026-10-10T22:00:00Z', 15)]);
    const result = await service.collectionPerformance(store, windows, 'collection-a');
    expect(repository.getCollection).toHaveBeenCalledWith('store-a', 'collection-a');
    expect(repository.getCommerceRows).toHaveBeenCalledWith('store-a', windows.comparison.instantFrom, windows.current.instantTo, ['product-a']);
    expect(result.current).toMatchObject({ orderCount: 1, soldUnits: 4, refundedUnits: 2, netUnits: 2, netProductRevenue: 30 });
    expect(result.comparison.netProductRevenue).toBe(10);
    expect(result.daily).toHaveLength(1);
    expect(result.daily[0]).toMatchObject({ date: '2026-10-12', netProductRevenue: 30 });
    expect(result.topProducts[0]).toMatchObject({ product: { id: 'product-a', title: 'Tee' }, netRevenue: 30 });
  });
  it('returns empty metrics without reading orders for an empty collection', async () => {
    const { repository, service } = setup();
    repository.getCollection.mockResolvedValue({ id: 'collection-a', title: 'Empty', products: [] });
    const result = await service.collectionPerformance(store, windows, 'collection-a');
    expect(repository.getCommerceRows).not.toHaveBeenCalled();
    expect(result.current.orderCount).toBe(0);
    expect(result.topProducts).toEqual([]);
  });
  it('rejects a missing collection before reading commerce', async () => {
    const { repository, service } = setup();
    repository.getCollection.mockResolvedValue(null as never);
    await expect(service.collectionPerformance(store, windows, 'other-store-collection')).rejects.toMatchObject({ code: 'COLLECTION_NOT_FOUND', statusCode: 404 });
    expect(repository.getCommerceRows).not.toHaveBeenCalled();
  });
});
