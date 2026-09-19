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

type CollectionCreateResponse = {
  collectionCreate?: {
    collection?: unknown | null;
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
    this.authService = input?.authService ?? new ShopifyAuthService(this.repository, this.apiService);
    this.catalogRepository = input?.catalogRepository ?? new ShopifyCatalogRepository();
  }

  async create(storeId: string, title: string, productIds: string[] = []) {
    const store = await this.repository.findConnectionForSync(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const connection = store.shopifyConnection;
    if (!connection) {
      throw new AppError('Shopify is not connected for this store', 409, 'SHOPIFY_NOT_CONNECTED');
    }
    if (connection.status !== 'ACTIVE') {
      throw new AppError('Shopify connection requires merchant attention', 409, 'SHOPIFY_CONNECTION_INACTIVE');
    }
    if (!connection.scopes.includes('write_products')) {
      throw new AppError(
        'Creating Shopify collections requires write_products. Reconnect Shopify once to approve the new collection-management permission.',
        409,
        'SHOPIFY_COLLECTION_WRITE_SCOPE_REQUIRED',
      );
    }

    const uniqueProductIds = [...new Set(productIds)];
    const selectedProducts = uniqueProductIds.length
      ? await prisma.product.findMany({
          where: { id: { in: uniqueProductIds }, storeId, deletedAt: null },
          select: { id: true, shopifyProductId: true, title: true },
        })
      : [];
    if (selectedProducts.length !== uniqueProductIds.length) {
      throw new AppError(
        'One or more selected products are not available in this store.',
        422,
        'SHOPIFY_COLLECTION_PRODUCTS_INVALID',
      );
    }

    const accessToken = await this.authService.resolveAccessToken(store.myshopifyDomain, connection);
    const collectionInput: Record<string, unknown> = { title };
    if (selectedProducts.length > 0) {
      collectionInput.sources = [
        {
          source: {
            title: `${title} products`,
            inclusion: {
              selections: selectedProducts.map((product) => ({ productId: product.shopifyProductId })),
            },
          },
        },
      ];
    }

    const response = await this.apiService.requestAdminGraphql<CollectionCreateResponse>({
      shop: store.myshopifyDomain,
      accessToken,
      apiVersion: connection.apiVersion,
      connectionId: connection.id,
      query: COLLECTION_CREATE_MUTATION,
      variables: { collection: collectionInput },
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

    if (selectedProducts.length > 0) {
      await prisma.$transaction(async (tx) => {
        await tx.productCollection.deleteMany({ where: { collectionId: localCollection.id } });
        await tx.productCollection.createMany({
          data: selectedProducts.map((product, index) => ({
            collectionId: localCollection.id,
            productId: product.id,
            position: index + 1,
          })),
          skipDuplicates: true,
        });
      });
    }

    await invalidateStoreDecisionCaches(storeId);

    return {
      collection: {
        id: localCollection.id,
        shopifyCollectionId: collection.data.id,
        title: collection.data.title,
        handle: collection.data.handle ?? null,
        productCount: selectedProducts.length,
      },
    };
  }
}

export const shopifyCollectionService = new ShopifyCollectionService();
