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
    const rows = await prisma.inventorySnapshot.findMany({
      where: {
        observedAt: { gte: windows.current.instantFrom, lte: windows.current.instantTo },
        inventoryItem: {
          storeId,
          deletedAt: null,
          variant: { productId, deletedAt: null },
        },
        location: { storeId, deletedAt: null },
      },
      select: {
        inventoryItemId: true,
        locationId: true,
        available: true,
        incoming: true,
        committed: true,
        onHand: true,
        observedAt: true,
      },
      orderBy: { observedAt: 'asc' },
    });

    const latest = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      const date = storeDate(row.observedAt, store.ianaTimezone);
      latest.set(`${date}:${row.inventoryItemId}:${row.locationId}`, row);
    }

    const grouped = new Map<string, { available: number; incoming: number; committed: number; onHand: number }>();
    for (const row of latest.values()) {
      const date = storeDate(row.observedAt, store.ianaTimezone);
      const bucket = grouped.get(date) ?? { available: 0, incoming: 0, committed: 0, onHand: 0 };
      bucket.available += row.available;
      bucket.incoming += row.incoming;
      bucket.committed += row.committed;
      bucket.onHand += row.onHand;
      grouped.set(date, bucket);
    }

    return {
      window: windowResponse(windows),
      product,
      methodology: 'LATEST_DAILY_VARIANT_LOCATION_SNAPSHOT_SUM' as const,
      points: [...grouped.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([date, values]) => ({ date, ...values })),
    };
  }
}

export const productDetailSupportService = new ProductDetailSupportService();
