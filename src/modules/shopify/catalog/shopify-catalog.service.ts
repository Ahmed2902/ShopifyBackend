import { AppError } from '../../../errors/app-error.js';
import type { IntegrationService } from '../../integrations/integration.service.js';
import type { ShopifyRepository } from '../shopify.repository.js';
import { PRODUCTS_QUERY, PRODUCT_VARIANTS_QUERY } from '../shopify.queries.js';
import {
  shopifyProductConnectionSchema,
  shopifyProductSchema,
  shopifyVariantConnectionSchema,
} from '../shopify.schema.js';
import type {
  ShopifyProductsQueryData,
  ShopifyRequestContext,
  ShopifySyncContext,
  ShopifySyncStats,
  ShopifyVariantsQueryData,
} from '../shopify.types.js';
import { paginateShopifyConnection } from '../shopify.utils.js';
import type { ShopifyApiService } from '../shared/shopify-api.service.js';
import { PRODUCT_BY_ID_QUERY, PRODUCT_VARIANTS_BY_ID_QUERY } from './shopify-catalog.queries.js';

const SHOPIFY_PAGE_SIZE = 100;

export class ShopifyCatalogService {
  constructor(
    private readonly repository: ShopifyRepository,
    private readonly integrationService: IntegrationService,
    private readonly apiService: ShopifyApiService,
  ) {}

  async sync(input: ShopifySyncContext): Promise<{
    products: ShopifySyncStats;
    variants: ShopifySyncStats;
  }> {
    const products = await this.syncProducts(input);
    const variants = await this.syncVariants(input);
    return { products, variants };
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
    }

    return { found: true, variantIds };
  }

  private async syncProducts(input: ShopifySyncContext): Promise<ShopifySyncStats> {
    let read = 0;
    let written = 0;

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
      for (const product of products) {
        await this.repository.upsertProduct(input.storeId, product);
        written += 1;
      }
    }

    return { read, written };
  }

  private async syncVariants(input: ShopifySyncContext): Promise<ShopifySyncStats> {
    let read = 0;
    let written = 0;

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
      for (const variant of variants) {
        const persisted = await this.repository.upsertVariant(input.storeId, variant);
        if (!persisted) {
          throw new AppError(
            'Shopify variant references a product that was not synchronized',
            502,
            'SHOPIFY_CATALOG_INCONSISTENT',
          );
        }
        written += 1;
      }
    }

    return { read, written };
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
