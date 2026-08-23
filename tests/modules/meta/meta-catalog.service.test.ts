import { describe, expect, it, vi } from 'vitest';
import type { MetaCatalogRepository } from '../../../src/modules/meta/catalog/meta-catalog.repository.js';
import { MetaCatalogService } from '../../../src/modules/meta/catalog/meta-catalog.service.js';
import type { MetaApiService } from '../../../src/modules/meta/shared/meta-api.service.js';

const context = {
  storeId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  connectionId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  accessToken: 'token',
  apiVersion: 'v26.0',
};

const providerCatalog = {
  id: 'cat_1',
  name: 'Store Catalog',
  business: { id: 'biz_1', name: 'Business' },
  owner_business: { id: 'biz_1', name: 'Business' },
  vertical: 'commerce',
  product_count: 2,
  feed_count: 1,
};
const items = [
  {
    id: 'item_1',
    retailer_id: 'SKU-1',
    retailer_product_group_id: 'GROUP-1',
    name: 'Black / S',
    color: 'Black',
    size: 'S',
    url: 'https://store.test/products/hoodie?variant=1',
  },
  {
    id: 'item_2',
    retailer_id: 'SKU-2',
    retailer_product_group_id: 'GROUP-1',
    name: 'Black / M',
    color: 'Black',
    size: 'M',
    url: 'https://store.test/products/hoodie?variant=2',
  },
];

function build() {
  const repository = {
    configureSelection: vi.fn().mockResolvedValue({ selectedCatalogIds: ['cat_1'] }),
    findCatalog: vi.fn().mockResolvedValue({ id: 'local-cat', metaCatalogId: 'cat_1' }),
    upsertItem: vi.fn().mockResolvedValue(undefined),
    softDeleteMissingItems: vi.fn().mockResolvedValue({ count: 1 }),
    markCatalogSynced: vi.fn().mockResolvedValue(undefined),
  } as unknown as MetaCatalogRepository;
  const apiService = {
    collectGraphPages: vi.fn().mockImplementation(
      async (
        _context: unknown,
        path: string,
        _params: unknown,
        parseItem: (value: unknown) => unknown | null,
      ) => {
        const providerRows = path.includes('owned_product_catalogs') ? [providerCatalog] : items;
        return providerRows.map(parseItem).filter((value) => value !== null);
      },
    ),
  } as unknown as MetaApiService;
  return { repository, apiService, service: new MetaCatalogService(repository, apiService) };
}

describe('MetaCatalogService', () => {
  it('discovers and de-duplicates catalogs across accessible businesses', async () => {
    const { apiService, service } = build();
    const result = await service.discoverOwnedCatalogs(context, ['biz_1', 'biz_2']);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ id: 'cat_1', businessId: 'biz_1', vertical: 'commerce' });
    expect(apiService.collectGraphPages).toHaveBeenCalledTimes(2);
  });

  it('rejects inaccessible catalog selections before persistence', async () => {
    const { repository, service } = build();
    const discovered = await service.discoverOwnedCatalogs(context, ['biz_1']);

    await expect(
      service.configureCatalogs(context, discovered, ['cat_missing']),
    ).rejects.toMatchObject({ code: 'META_CATALOG_NOT_ACCESSIBLE' });
    expect(repository.configureSelection).not.toHaveBeenCalled();
  });

  it('syncs all selected catalog items and tombstones items missing from the completed snapshot', async () => {
    const { repository, service } = build();

    const result = await service.syncSelectedCatalogs(context, ['cat_1']);

    expect(repository.upsertItem).toHaveBeenCalledTimes(2);
    expect(repository.softDeleteMissingItems).toHaveBeenCalledWith('local-cat', ['item_1', 'item_2']);
    expect(repository.markCatalogSynced).toHaveBeenCalledWith('local-cat');
    expect(result).toEqual({
      recordsRead: 3,
      recordsWritten: 4,
      breakdown: {
        catalogs: 1,
        items: 2,
        softDeletedItems: 1,
        byCatalog: [{ catalogId: 'cat_1', items: 2, softDeletedItems: 1 }],
      },
    });
  });

  it('does not mutate item state if the selected catalog was never configured', async () => {
    const { repository, service } = build();
    vi.mocked(repository.findCatalog).mockResolvedValue(null);

    await expect(service.syncSelectedCatalogs(context, ['cat_missing'])).rejects.toMatchObject({
      code: 'META_CATALOG_NOT_CONFIGURED',
    });
    expect(repository.upsertItem).not.toHaveBeenCalled();
    expect(repository.softDeleteMissingItems).not.toHaveBeenCalled();
  });
});
