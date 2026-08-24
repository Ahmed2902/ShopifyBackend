import { AppError } from '../../../errors/app-error.js';
import type { TikTokApiService } from '../shared/tiktok-api.service.js';
import type { TikTokRepository } from '../tiktok.repository.js';
import type { TikTokApiContext, TikTokObject } from '../tiktok.types.js';
import { asNumber, asRecord, asString } from '../tiktok.utils.js';
import type { TikTokCatalogRepository } from './tiktok-catalog.repository.js';

function value(record: TikTokObject, ...keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key];
  return undefined;
}
function stringValue(record: TikTokObject, ...keys: string[]) { return asString(value(record, ...keys)); }
function numberValue(record: TikTokObject, ...keys: string[]) { return asNumber(value(record, ...keys)); }

export class TikTokCatalogService {
  constructor(
    private readonly repository: TikTokCatalogRepository,
    private readonly connectionRepository: TikTokRepository,
    private readonly apiService: TikTokApiService,
  ) {}

  async discoverAccessibleCatalogs(context: TikTokApiContext, businessCenterIds: string[]) {
    const catalogs: TikTokObject[] = [];
    for (const businessCenterId of businessCenterIds) {
      const found = await this.apiService.paginate(
        context,
        'catalog/get',
        { bc_id: businessCenterId },
        ['catalogs', 'list'],
      ).catch(() => []);
      for (const catalog of found) catalogs.push({ ...catalog, business_center_id: businessCenterId });
    }
    return catalogs.map((record) => this.toCatalogAsset(record));
  }

  async configureCatalogs(storeId: string, context: TikTokApiContext, catalogIds: string[]) {
    if (!context.businessCenterId && catalogIds.length > 0) {
      throw new AppError('Select a TikTok Business Center before selecting catalogs', 400, 'TIKTOK_BUSINESS_CENTER_REQUIRED');
    }
    const accessible = context.businessCenterId
      ? await this.apiService.paginate(context, 'catalog/get', { bc_id: context.businessCenterId }, ['catalogs', 'list'])
      : [];
    const byId = new Map(accessible.map((record) => [stringValue(record, 'catalog_id', 'id'), record]));
    const missing = catalogIds.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new AppError('Selected TikTok catalog is not accessible', 400, 'TIKTOK_CATALOG_NOT_ACCESSIBLE', { catalogIds: missing });
    }

    for (const id of catalogIds) {
      const record = byId.get(id)!;
      await this.repository.upsertCatalog({
        storeId,
        connectionId: context.connectionId,
        ...this.toCatalogAsset(record),
        raw: record,
      });
    }
    await this.connectionRepository.configureCatalogs(context.connectionId, catalogIds);
  }

  listCatalogs(storeId: string) {
    return this.repository.listCatalogs(storeId);
  }

  listCatalogItems(storeId: string, catalogId: string, page: number, limit: number) {
    return this.repository.listCatalogItems(storeId, catalogId, page, limit)
      .then(([items, total]) => ({ items, page, limit, total }));
  }

  async syncSelectedCatalogs(storeId: string, context: TikTokApiContext) {
    if (!context.businessCenterId) {
      throw new AppError('TikTok Business Center is not configured', 409, 'TIKTOK_BUSINESS_CENTER_REQUIRED');
    }
    let recordsRead = 0;
    let recordsWritten = 0;
    const catalogs = await this.apiService.paginate(context, 'catalog/get', { bc_id: context.businessCenterId }, ['catalogs', 'list']);
    const selected = catalogs.filter((record) => {
      const id = stringValue(record, 'catalog_id', 'id');
      return id ? context.selectedCatalogIds.includes(id) : false;
    });

    for (const record of selected) {
      const asset = this.toCatalogAsset(record);
      const catalog = await this.repository.upsertCatalog({
        storeId,
        connectionId: context.connectionId,
        ...asset,
        businessCenterId: context.businessCenterId,
        raw: record,
      });
      recordsWritten += 1;
      const items = await this.apiService.paginate(
        context,
        'catalog/product/get',
        { bc_id: context.businessCenterId, catalog_id: asset.tiktokCatalogId },
        ['products', 'list'],
      );
      recordsRead += items.length;
      const activeIds: string[] = [];
      for (const item of items) {
        const externalId = stringValue(item, 'product_id', 'id');
        if (!externalId) continue;
        activeIds.push(externalId);
        const price = asRecord(value(item, 'price'));
        const salePrice = asRecord(value(item, 'sale_price'));
        await this.repository.upsertCatalogItem({
          catalogId: catalog.id,
          tiktokProductId: externalId,
          retailerId: stringValue(item, 'retailer_id', 'sku'),
          itemGroupId: stringValue(item, 'item_group_id', 'retailer_product_group_id'),
          title: stringValue(item, 'title', 'name'),
          description: stringValue(item, 'description'),
          brand: stringValue(item, 'brand'),
          availability: stringValue(item, 'availability'),
          price: numberValue(item, 'price') ?? asNumber(price.price),
          salePrice: numberValue(item, 'sale_price') ?? asNumber(salePrice.price),
          currency: stringValue(item, 'currency') ?? asString(price.currency),
          size: stringValue(item, 'size'),
          color: stringValue(item, 'color'),
          pattern: stringValue(item, 'pattern'),
          url: stringValue(item, 'link', 'url'),
          imageUrl: stringValue(item, 'image_link', 'image_url'),
          productType: stringValue(item, 'product_type'),
          category: stringValue(item, 'category', 'google_product_category'),
          customLabels: value(item, 'custom_labels'),
          variants: value(item, 'variants'),
          videoIds: value(item, 'video_ids'),
          status: stringValue(item, 'status'),
          raw: item,
        });
        recordsWritten += 1;
      }
      await this.repository.tombstoneMissingCatalogItems(catalog.id, activeIds);
    }

    return { recordsRead, recordsWritten };
  }

  private toCatalogAsset(record: TikTokObject) {
    const tiktokCatalogId = stringValue(record, 'catalog_id', 'id');
    if (!tiktokCatalogId) throw new AppError('TikTok returned a catalog without an ID', 502, 'TIKTOK_BAD_RESPONSE');
    return {
      tiktokCatalogId,
      name: stringValue(record, 'catalog_name', 'name') ?? tiktokCatalogId,
      businessCenterId: stringValue(record, 'business_center_id', 'bc_id'),
      catalogType: stringValue(record, 'catalog_type'),
      vertical: stringValue(record, 'vertical'),
      region: stringValue(record, 'region'),
      currency: stringValue(record, 'currency'),
      productCount: numberValue(record, 'product_count'),
    };
  }
}
