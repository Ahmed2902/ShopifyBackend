import { AppError } from '../../../errors/app-error.js';
import type { IntegrationService } from '../../integrations/integration.service.js';
import type { ShopifyRepository } from '../shopify.repository.js';
import {
  COLLECTION_PRODUCTS_QUERY,
  COLLECTIONS_QUERY,
  PRODUCTS_QUERY,
  PRODUCT_VARIANTS_QUERY,
} from '../shopify.queries.js';
import {
  shopifyCollectionConnectionSchema,
  shopifyCollectionProductConnectionSchema,
  shopifyProductConnectionSchema,
  shopifyProductSchema,
  shopifyVariantConnectionSchema,
} from '../shopify.schema.js';
import type {
  ShopifyCollectionProductsQueryData,
  ShopifyCollectionsQueryData,
  ShopifyProductsQueryData,
  ShopifyRequestContext,
  ShopifyResourceSyncStats,
  ShopifySyncContext,
  ShopifyVariantsQueryData,
} from '../shopify.types.js';
import { paginateShopifyConnection } from '../shopify.utils.js';
import type { ShopifyApiService } from '../shared/shopify-api.service.js';
import { PRODUCT_BY_ID_QUERY, PRODUCT_VARIANTS_BY_ID_QUERY } from './shopify-catalog.queries.js';
import { ShopifyCatalogRepository } from './shopify-catalog.repository.js';

const SHOPIFY_PAGE_SIZE = 250;

export class ShopifyCatalogService {
  constructor(
    private readonly repository: ShopifyRepository,
    private readonly integrationService: IntegrationService,
    private readonly apiService: ShopifyApiService,
    private readonly syncRepository: ShopifyCatalogRepository = new ShopifyCatalogRepository(),
  ) {}

  async sync(input: ShopifySyncContext): Promise<{
    products: ShopifyResourceSyncStats;
    variants: ShopifyResourceSyncStats;
    collections: ShopifyResourceSyncStats;
  }> {
    const products = await this.syncProducts(input);
    const variants = await this.syncVariants(input);
    const collections = await this.syncCollections(input);
    await Promise.all([
      this.repository.markMissingCatalogDeleted(input.storeId, products.ids, variants.ids),
      this.syncRepository.markMissingCollectionsDeleted(input.storeId, collections.ids),
    ]);
    return { products, variants, collections };
  }

  async reconcileProduct(
    input: ShopifyRequestContext,
    productId: string,
  ): Promise<{ found: boolean; variantIds: string[] }> {
    const data = await this.apiService.requestAdminGraphql<{ product: unknown | null }>({
      shop: input.shop,
      accessToken: input.accessToken,
      apiVersion: input.apiVersion,
      connectionId: input.connectionId,
      query: PRODUCT_BY_ID_QUERY,
      variables: { id: productId },
    });
    if (!data.product) return { found: false, variantIds: [] };

    const product = shopifyProductSchema.safeParse(data.product);
    if (!product.success) {
      throw new AppError(
        'Shopify product webhook reconciliation returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    if (product.data.id !== productId) {
      throw new AppError(
        'Shopify returned a different product during webhook reconciliation',
        502,
        'SHOPIFY_CATALOG_INCONSISTENT',
      );
    }
    await this.repository.upsertProduct(input.storeId, product.data);

    const variantIds: string[] = [];
    const pages = paginateShopifyConnection(async (cursor) => {
      const variantData = await this.apiService.requestAdminGraphql<{
        product: { variants: unknown } | null;
      }>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: PRODUCT_VARIANTS_BY_ID_QUERY,
        variables: { id: productId, first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      if (!variantData.product) {
        throw new AppError(
          'Shopify product disappeared during webhook reconciliation',
          502,
          'SHOPIFY_CATALOG_INCONSISTENT',
        );
      }
      const variants = shopifyVariantConnectionSchema.safeParse(variantData.product.variants);
      if (!variants.success) {
        throw new AppError(
          'Shopify product variants webhook reconciliation returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      return variants.data;
    });

    for await (const variants of pages) {
      for (const variant of variants) {
        const persisted = await this.repository.upsertVariant(input.storeId, variant);
        if (!persisted) {
          throw new AppError(
            'Shopify variant references a product that was not synchronized',
            502,
            'SHOPIFY_CATALOG_INCONSISTENT',
          );
        }
        variantIds.push(variant.id);
      }
      await this.syncRepository.persistShopifyCosts(input.storeId, variants);
    }

    return { found: true, variantIds };
  }

  private async syncProducts(input: ShopifySyncContext): Promise<ShopifyResourceSyncStats> {
    let read = 0;
    let written = 0;
    const ids: string[] = [];

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.apiService.requestAdminGraphql<ShopifyProductsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: PRODUCTS_QUERY,
        variables: { first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      const connection = shopifyProductConnectionSchema.safeParse(data.products);
      if (!connection.success) {
        throw new AppError('Shopify products query returned an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }
      await this.recordPagePayload(input, 'ProductsPage', connection.data);
      return connection.data;
    });

    for await (const products of pages) {
      read += products.length;
      await this.syncRepository.persistProducts(input.storeId, products);
      ids.push(...products.map((product) => product.id));
      written += products.length;
    }

    return { read, written, ids };
  }

  private async syncVariants(input: ShopifySyncContext): Promise<ShopifyResourceSyncStats> {
    let read = 0;
    let written = 0;
    const ids: string[] = [];

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.apiService.requestAdminGraphql<ShopifyVariantsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: PRODUCT_VARIANTS_QUERY,
        variables: { first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      const connection = shopifyVariantConnectionSchema.safeParse(data.productVariants);
      if (!connection.success) {
        throw new AppError('Shopify variants query returned an unexpected shape', 502, 'SHOPIFY_BAD_RESPONSE');
      }
      await this.recordPagePayload(input, 'ProductVariantsPage', connection.data);
      return connection.data;
    });

    for await (const variants of pages) {
      read += variants.length;
      const persisted = await this.syncRepository.persistVariants(input.storeId, variants);
      if (!persisted) {
        throw new AppError(
          'Shopify variant references catalog data that was not synchronized',
          502,
          'SHOPIFY_CATALOG_INCONSISTENT',
        );
      }
      ids.push(...variants.map((variant) => variant.id));
      written += variants.length;
    }

    return { read, written, ids };
  }

  private async syncCollections(input: ShopifySyncContext): Promise<ShopifyResourceSyncStats> {
    let read = 0;
    let written = 0;
    const ids: string[] = [];

    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.apiService.requestAdminGraphql<ShopifyCollectionsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: COLLECTIONS_QUERY,
        variables: { first: SHOPIFY_PAGE_SIZE, after: cursor },
      });
      const connection = shopifyCollectionConnectionSchema.safeParse(data.collections);
      if (!connection.success) {
        throw new AppError(
          'Shopify collections query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      await this.recordPagePayload(input, 'CollectionsPage', connection.data);
      return connection.data;
    });

    for await (const collections of pages) {
      read += collections.length;
      await this.syncRepository.persistCollections(input.storeId, collections);
      for (const collection of collections) {
        const productIds = await this.loadCollectionProductIds(input, collection.id);
        const persisted = await this.syncRepository.replaceCollectionProducts(
          input.storeId,
          collection.id,
          productIds,
        );
        if (!persisted) {
          throw new AppError(
            'Shopify collection references catalog products that were not synchronized',
            502,
            'SHOPIFY_CATALOG_INCONSISTENT',
          );
        }
      }
      ids.push(...collections.map((collection) => collection.id));
      written += collections.length;
    }

    return { read, written, ids };
  }

  private async loadCollectionProductIds(
    input: ShopifySyncContext,
    collectionId: string,
  ): Promise<string[]> {
    const ids: string[] = [];
    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.apiService.requestAdminGraphql<ShopifyCollectionProductsQueryData>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: COLLECTION_PRODUCTS_QUERY,
        variables: {
          id: collectionId,
          first: SHOPIFY_PAGE_SIZE,
          after: cursor,
        },
      });
      if (!data.collection || data.collection.id !== collectionId) {
        throw new AppError(
          'Shopify collection disappeared during product membership sync',
          502,
          'SHOPIFY_CATALOG_INCONSISTENT',
        );
      }
      const connection = shopifyCollectionProductConnectionSchema.safeParse(data.collection.products);
      if (!connection.success) {
        throw new AppError(
          'Shopify collection products query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      return connection.data;
    });

    for await (const products of pages) {
      ids.push(...products.map((product) => product.id));
    }
    return ids;
  }

  private recordPagePayload(
    input: ShopifySyncContext,
    resourceType: string,
    payload: unknown,
  ) {
    return this.integrationService.recordExternalPayload({
      provider: 'SHOPIFY',
      resourceType,
      apiVersion: input.apiVersion,
      payload,
      syncRunId: input.syncRunId,
    });
  }
}
