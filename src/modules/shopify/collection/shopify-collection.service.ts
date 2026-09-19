import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { invalidateStoreDecisionCaches } from '../../../lib/store-decision-cache.js';
import { ShopifyCatalogRepository } from '../catalog/shopify-catalog.repository.js';
import { ShopifyRepository } from '../shopify.repository.js';
import { shopifyCollectionSchema } from '../shopify.schema.js';
import { ShopifyApiService } from '../shared/shopify-api.service.js';
import { ShopifyAuthService } from '../shared/shopify-auth.service.js';

const COLLECTION_CREATE_MUTATION = `#graphql
  mutation StrideCollectionCreate($collection: CollectionCreateInput!) {
    collectionCreate(collection: $collection) {
      collection {
        id
        title
        handle
        descriptionHtml
        sortOrder
        updatedAt
        image { url }
      }
      userErrors { field message }
    }
  }
`;

const COLLECTION_ADD_PRODUCTS_MUTATION = `#graphql
  mutation StrideCollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      userErrors { field message }
    }
  }
`;

type CollectionCreateResponse = {
  collectionCreate?: {
    collection?: unknown | null;
    userErrors?: Array<{ field?: string[] | null; message: string }>;
  } | null;
};

type CollectionAddProductsResponse = {
  collectionAddProducts?: {
    userErrors?: Array<{ field?: string[] | null; message: string }>;
  } | null;
};

export class ShopifyCollectionService {
  private readonly repository: ShopifyRepository;
  private readonly apiService: ShopifyApiService;
  private readonly authService: ShopifyAuthService;
  private readonly catalogRepository: ShopifyCatalogRepository;

  constructor(input?: {
    repository?: ShopifyRepository;
    apiService?: ShopifyApiService;
    authService?: ShopifyAuthService;
    catalogRepository?: ShopifyCatalogRepository;
  }) {
    this.repository = input?.repository ?? new ShopifyRepository();
    this.apiService = input?.apiService ?? new ShopifyApiService(this.repository);
    this.authService =
      input?.authService ?? new ShopifyAuthService(this.repository, this.apiService);
    this.catalogRepository = input?.catalogRepository ?? new ShopifyCatalogRepository();
  }

  async create(storeId: string, title: string) {
    const store = await this.requireWritableStore(storeId);
    const connection = store.shopifyConnection!;
    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
    const response = await this.apiService.requestAdminGraphql<CollectionCreateResponse>({
      shop: store.myshopifyDomain,
      accessToken,
      apiVersion: connection.apiVersion,
      connectionId: connection.id,
      query: COLLECTION_CREATE_MUTATION,
      variables: { collection: { title } },
    });

    const result = response.collectionCreate;
    const errors = result?.userErrors ?? [];
    if (errors.length > 0) {
      throw new AppError(
        errors[0]?.message ?? 'Shopify rejected the collection',
        422,
        'SHOPIFY_COLLECTION_CREATE_FAILED',
        { userErrors: errors.slice(0, 5) },
      );
    }

    const collection = shopifyCollectionSchema.safeParse(result?.collection);
    if (!collection.success) {
      throw new AppError(
        'Shopify collection creation returned an unexpected response',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }

    await this.catalogRepository.persistCollections(storeId, [collection.data]);
    const localCollection = await prisma.collection.findUnique({
      where: {
        storeId_shopifyCollectionId: {
          storeId,
          shopifyCollectionId: collection.data.id,
        },
      },
      select: { id: true },
    });
    if (!localCollection) {
      throw new AppError(
        'The collection was created in Shopify but Stride could not read the synchronized record.',
        500,
        'SHOPIFY_COLLECTION_LOCAL_SYNC_FAILED',
      );
    }

    await invalidateStoreDecisionCaches(storeId);

    return {
      collection: {
        id: localCollection.id,
        shopifyCollectionId: collection.data.id,
        title: collection.data.title,
        handle: collection.data.handle ?? null,
      },
    };
  }

  async addProducts(storeId: string, collectionId: string, productIds: string[]) {
    const store = await this.requireWritableStore(storeId);
    const connection = store.shopifyConnection!;
    const [collection, products] = await Promise.all([
      prisma.collection.findFirst({
        where: { id: collectionId, storeId, deletedAt: null },
        select: { id: true, shopifyCollectionId: true },
      }),
      prisma.product.findMany({
        where: { id: { in: productIds }, storeId, deletedAt: null },
        select: { id: true, shopifyProductId: true },
      }),
    ]);

    if (!collection) throw new AppError('Collection not found', 404, 'COLLECTION_NOT_FOUND');
    if (products.length !== productIds.length) {
      throw new AppError(
        'One or more selected products do not belong to this store or are no longer available',
        404,
        'PRODUCT_NOT_FOUND',
      );
    }

    const accessToken = await this.authService.resolveAccessToken(
      store.myshopifyDomain,
      connection,
    );
    const response = await this.apiService.requestAdminGraphql<CollectionAddProductsResponse>({
      shop: store.myshopifyDomain,
      accessToken,
      apiVersion: connection.apiVersion,
      connectionId: connection.id,
      query: COLLECTION_ADD_PRODUCTS_MUTATION,
      variables: {
        id: collection.shopifyCollectionId,
        productIds: products.map((product) => product.shopifyProductId),
      },
    });

    const errors = response.collectionAddProducts?.userErrors ?? [];
    if (errors.length > 0) {
      throw new AppError(
        errors[0]?.message ?? 'Shopify rejected the collection membership update',
        422,
        'SHOPIFY_COLLECTION_ADD_PRODUCTS_FAILED',
        { userErrors: errors.slice(0, 5) },
      );
    }

    await prisma.productCollection.createMany({
      data: products.map((product) => ({
        collectionId: collection.id,
        productId: product.id,
      })),
      skipDuplicates: true,
    });
    await invalidateStoreDecisionCaches(storeId);

    return { added: products.length };
  }

  private async requireWritableStore(storeId: string) {
    const store = await this.repository.findConnectionForSync(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const connection = store.shopifyConnection;
    if (!connection) {
      throw new AppError('Shopify is not connected for this store', 409, 'SHOPIFY_NOT_CONNECTED');
    }
    if (connection.status !== 'ACTIVE') {
      throw new AppError(
        'Shopify connection requires merchant attention',
        409,
        'SHOPIFY_CONNECTION_INACTIVE',
      );
    }
    if (!connection.scopes.includes('write_products')) {
      throw new AppError(
        'Managing Shopify collections requires write_products. Reconnect Shopify once to approve the collection-management permission.',
        409,
        'SHOPIFY_COLLECTION_WRITE_SCOPE_REQUIRED',
      );
    }
    return store;
  }
}

export const shopifyCollectionService = new ShopifyCollectionService();
