import { AppError } from '../../../errors/app-error.js';
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
    this.authService =
      input?.authService ?? new ShopifyAuthService(this.repository, this.apiService);
    this.catalogRepository = input?.catalogRepository ?? new ShopifyCatalogRepository();
  }

  async create(storeId: string, title: string) {
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
        'Creating Shopify collections requires write_products. Reconnect Shopify once to approve the new collection-management permission.',
        409,
        'SHOPIFY_COLLECTION_WRITE_SCOPE_REQUIRED',
      );
    }

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
    await invalidateStoreDecisionCaches(storeId);

    return {
      collection: {
        shopifyCollectionId: collection.data.id,
        title: collection.data.title,
        handle: collection.data.handle ?? null,
      },
    };
  }
}

export const shopifyCollectionService = new ShopifyCollectionService();
