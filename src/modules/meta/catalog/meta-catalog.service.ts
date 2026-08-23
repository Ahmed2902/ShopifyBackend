import { AppError } from '../../../errors/app-error.js';
import type { MetaApiContext, MetaCatalogAsset } from '../meta.types.js';
import { toJsonSafe } from '../meta.utils.js';
import type { MetaApiService } from '../shared/meta-api.service.js';
import type { MetaCatalogRepository } from './meta-catalog.repository.js';
import { metaCatalogItemSchema, metaProductCatalogSchema } from './meta-catalog.schema.js';

const CATALOG_FIELDS = [
  'id',
  'name',
  'business{id,name}',
  'owner_business{id,name}',
  'vertical',
  'product_count',
  'feed_count',
].join(',');
const ITEM_FIELDS = [
  'id',
  'retailer_id',
  'retailer_product_group_id',
  'parent_product_id',
  'name',
  'brand',
  'availability',
  'price',
  'sale_price',
  'currency',
  'size',
  'color',
  'pattern',
  'url',
  'product_type',
  'custom_label_0',
  'custom_label_1',
  'custom_label_2',
  'custom_label_3',
  'custom_label_4',
  'product_feed{id}',
  'quantity_to_sell_on_facebook',
  'status',
  'visibility',
].join(',');

function parseCatalog(value: unknown): MetaCatalogAsset | null {
  const parsed = metaProductCatalogSchema.safeParse(value);
  if (!parsed.success) throw new AppError('Meta catalog response was invalid', 502, 'META_BAD_RESPONSE');
  const catalog = parsed.data;
  return {
    id: catalog.id,
    name: catalog.name,
    businessId: catalog.business?.id ?? null,
    ownerBusinessId: catalog.owner_business?.id ?? null,
    vertical: catalog.vertical ?? null,
    productCount: catalog.product_count ?? null,
    feedCount: catalog.feed_count ?? null,
    raw: value,
  };
}

export class MetaCatalogService {
  constructor(
    private readonly repository: MetaCatalogRepository,
    private readonly apiService: MetaApiService,
  ) {}

  async discoverOwnedCatalogs(context: MetaApiContext, businessIds: string[]) {
    const byId = new Map<string, MetaCatalogAsset>();
    for (const businessId of businessIds) {
      const catalogs = await this.apiService.collectGraphPages(
        context,
        `/${businessId}/owned_product_catalogs`,
        { fields: CATALOG_FIELDS, limit: '100' },
        parseCatalog,
      );
      for (const catalog of catalogs) byId.set(catalog.id, catalog);
    }
    return [...byId.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  async configureCatalogs(
    context: MetaApiContext,
    accessibleCatalogs: MetaCatalogAsset[],
    requestedCatalogIds: string[],
  ) {
    const requested = new Set(requestedCatalogIds);
    const selected = accessibleCatalogs.filter((catalog) => requested.has(catalog.id));
    const selectedIds = new Set(selected.map((catalog) => catalog.id));
    const missing = requestedCatalogIds.filter((id) => !selectedIds.has(id));
    if (missing.length > 0) {
      throw new AppError(
        `Selected Meta catalogs are not accessible: ${missing.join(', ')}`,
        400,
        'META_CATALOG_NOT_ACCESSIBLE',
      );
    }

    await this.repository.configureSelection(context.storeId, context.connectionId, selected);
    return selected.map((catalog) => ({
      id: catalog.id,
      name: catalog.name,
      vertical: catalog.vertical,
      productCount: catalog.productCount,
    }));
  }

  async syncSelectedCatalogs(context: MetaApiContext, selectedCatalogIds: string[]) {
    let recordsRead = 0;
    let recordsWritten = 0;
    let softDeletedItems = 0;
    const byCatalog: Array<{ catalogId: string; items: number; softDeletedItems: number }> = [];

    for (const metaCatalogId of selectedCatalogIds) {
      const catalog = await this.repository.findCatalog(
        context.storeId,
        context.connectionId,
        metaCatalogId,
      );
      if (!catalog) {
        throw new AppError(
          'Selected Meta catalog is missing from local configuration',
          409,
          'META_CATALOG_NOT_CONFIGURED',
        );
      }

      const items = await this.apiService.collectGraphPages(
        context,
        `/${metaCatalogId}/products`,
        { fields: ITEM_FIELDS, limit: '100' },
        (value) => {
          const parsed = metaCatalogItemSchema.safeParse(value);
          if (!parsed.success) {
            throw new AppError('Meta catalog item response was invalid', 502, 'META_BAD_RESPONSE');
          }
          return parsed.data;
        },
      );
      for (const item of items) await this.repository.upsertItem(catalog.id, item);
      const deleted = await this.repository.softDeleteMissingItems(
        catalog.id,
        items.map((item) => item.id),
      );
      await this.repository.markCatalogSynced(catalog.id);

      recordsRead += 1 + items.length;
      recordsWritten += 1 + items.length + deleted.count;
      softDeletedItems += deleted.count;
      byCatalog.push({ catalogId: metaCatalogId, items: items.length, softDeletedItems: deleted.count });
    }

    return {
      recordsRead,
      recordsWritten,
      breakdown: {
        catalogs: selectedCatalogIds.length,
        items: byCatalog.reduce((sum, catalog) => sum + catalog.items, 0),
        softDeletedItems,
        byCatalog,
      },
    };
  }

  async listCatalogs(storeId: string, selectedCatalogIds: string[]) {
    return toJsonSafe(await this.repository.listCatalogs(storeId, selectedCatalogIds));
  }

  async listItems(storeId: string, catalogId: string, page: number, limit: number) {
    await this.repository.requireSelectedCatalog(storeId, catalogId);
    return toJsonSafe(await this.repository.listItems(storeId, catalogId, page, limit));
  }
}
