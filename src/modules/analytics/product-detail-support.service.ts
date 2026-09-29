import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { storeDate } from '../intelligence/intelligence.dates.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';

function imageUrl(raw: unknown): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const featuredMedia = (raw as { featuredMedia?: unknown }).featuredMedia;
  if (!featuredMedia || typeof featuredMedia !== 'object') return null;
  const preview = (featuredMedia as { preview?: unknown }).preview;
  if (!preview || typeof preview !== 'object') return null;
  const image = (preview as { image?: unknown }).image;
  if (!image || typeof image !== 'object') return null;
  const url = (image as { url?: unknown }).url;
  return typeof url === 'string' && url.length > 0 ? url : null;
}

function nextDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export class ProductDetailSupportService {
  async images(storeId: string, productIds: string[]) {
    if (productIds.length === 0) return { items: [] };
    const rows = await prisma.product.findMany({
      where: { storeId, id: { in: productIds }, deletedAt: null },
      select: { id: true, rawJson: true },
    });
    return {
      items: rows.map((row) => ({ productId: row.id, imageUrl: imageUrl(row.rawJson) })),
    };
  }

  async inventoryHistory(
    storeId: string,
    productId: string,
    query: AnalyticsRangeQuery,
    now = new Date(),
  ) {
    const [store, product] = await Promise.all([
      prisma.store.findUnique({ where: { id: storeId }, select: { ianaTimezone: true } }),
      prisma.product.findFirst({
        where: { id: productId, storeId, deletedAt: null },
        select: { id: true, title: true },
      }),
    ]);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    if (!product) throw new AppError('Product not found', 404, 'PRODUCT_NOT_FOUND');

    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const relationWhere = {
      inventoryItem: {
        storeId,
        deletedAt: null,
        variant: { productId, deletedAt: null },
      },
      location: { storeId, deletedAt: null },
    } as const;
    const select = {
      inventoryItemId: true,
      locationId: true,
      available: true,
      incoming: true,
      committed: true,
      onHand: true,
      observedAt: true,
    } as const;

    const [baselineRows, rows] = await Promise.all([
      prisma.inventorySnapshot.findMany({
        where: {
          observedAt: { lt: windows.current.instantFrom },
          ...relationWhere,
        },
        select,
        orderBy: [
          { inventoryItemId: 'asc' },
          { locationId: 'asc' },
          { observedAt: 'desc' },
        ],
        distinct: ['inventoryItemId', 'locationId'],
      }),
      prisma.inventorySnapshot.findMany({
        where: {
          observedAt: { gte: windows.current.instantFrom, lte: windows.current.instantTo },
          ...relationWhere,
        },
        select,
        orderBy: { observedAt: 'asc' },
      }),
    ]);

    type Snapshot = (typeof rows)[number];
    const pairKey = (row: Snapshot) => `${row.inventoryItemId}:${row.locationId}`;
    const state = new Map<string, Snapshot>();
    for (const row of baselineRows) state.set(pairKey(row), row);

    const updatesByDate = new Map<string, Map<string, Snapshot>>();
    for (const row of rows) {
      const date = storeDate(row.observedAt, store.ianaTimezone);
      const daily = updatesByDate.get(date) ?? new Map<string, Snapshot>();
      daily.set(pairKey(row), row);
      updatesByDate.set(date, daily);
    }

    const points: Array<{ date: string; available: number; incoming: number; committed: number; onHand: number }> = [];
    for (let date = windows.current.fromDate; date <= windows.current.toDate; date = nextDate(date)) {
      const updates = updatesByDate.get(date);
      if (updates) {
        for (const [key, row] of updates) state.set(key, row);
      }
      if (state.size === 0) continue;

      let available = 0;
      let incoming = 0;
      let committed = 0;
      let onHand = 0;
      for (const row of state.values()) {
        available += row.available;
        incoming += row.incoming;
        committed += row.committed;
        onHand += row.onHand;
      }
      points.push({ date, available, incoming, committed, onHand });
    }

    return {
      window: windowResponse(windows),
      product,
      methodology: 'CARRY_FORWARD_LATEST_VARIANT_LOCATION_BALANCE_SUM' as const,
      points,
    };
  }
}

export const productDetailSupportService = new ProductDetailSupportService();
