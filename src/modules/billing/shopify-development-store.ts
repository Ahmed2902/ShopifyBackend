import { AppError } from '../../errors/app-error.js';
import { ShopifyRepository } from '../shopify/shopify.repository.js';
import { ShopifyApiService } from '../shopify/shared/shopify-api.service.js';
import { ShopifyAuthService } from '../shopify/shared/shopify-auth.service.js';

const repository = new ShopifyRepository();
const api = new ShopifyApiService(repository);
const auth = new ShopifyAuthService(repository, api);

export async function verifyShopifyDevelopmentStore(storeId: string, shopId: string): Promise<boolean> {
  const store = await repository.findConnectionForSync(storeId);
  const connection = store?.shopifyConnection;
  if (!store || !connection || connection.status !== 'ACTIVE') {
    throw new AppError('Reopen Stride in Shopify to verify this development store.',
      503, 'SHOPIFY_BILLING_UNAVAILABLE');
  }
  const accessToken = await auth.resolveAccessToken(store.myshopifyDomain, connection);
  const data = await api.requestAdminGraphql<{ shop: { id: string; plan: { partnerDevelopment: boolean } } }>({
    shop: store.myshopifyDomain, connectionId: connection.id, accessToken,
    apiVersion: connection.apiVersion,
    query: `query BillingDevelopmentStore { shop { id plan { partnerDevelopment } } }`,
  });
  if (data.shop?.id !== shopId || typeof data.shop.plan?.partnerDevelopment !== 'boolean') {
    throw new AppError('Shopify development-store status could not be verified.',
      503, 'SHOPIFY_BILLING_UNAVAILABLE');
  }
  return data.shop.plan.partnerDevelopment;
}
