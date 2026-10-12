import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';

// Call only after verifying the provider's signed OAuth state. This is navigation
// context, never a merchant session or authorization to read store data.
export async function withProviderReturnShop(destination: string, verifiedStoreId: string) {
  if (env.LEGACY_MERCHANT_AUTH_ENABLED) return destination;
  const store = await prisma.store.findUnique({
    where: { id: verifiedStoreId },
    select: { myshopifyDomain: true },
  });
  const url = new URL(destination);
  if (store && /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(store.myshopifyDomain)) {
    url.searchParams.set('shop', store.myshopifyDomain);
  }
  return url.toString();
}
