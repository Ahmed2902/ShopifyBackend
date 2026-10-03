import { randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../integrations/integration.utils.js';
import { ShopifyRepository } from '../shopify/shopify.repository.js';
import { ShopifyApiService } from '../shopify/shared/shopify-api.service.js';
import { ShopifyAuthService } from '../shopify/shared/shopify-auth.service.js';
import type { ConversionDestinationConfig, DeliveryClaim } from './conversion-delivery.types.js';
import {
  customerIdentity,
  normalizeCustomerMatching,
  type BrowserMatchInput,
  type MatchEvidence,
} from './matching.js';
import { ConversionProviderError } from './providers/conversion-provider.error.js';

const repository = new ShopifyRepository();
const api = new ShopifyApiService(repository);
const auth = new ShopifyAuthService(repository, api);
type OrderMatch = {
  id: string;
  email?: string | null;
  phone?: string | null;
  customer?: { id: string } | null;
  billingAddress?: Address | null;
};
type Address = {
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  provinceCode?: string | null;
  zip?: string | null;
  countryCodeV2?: string | null;
};

// Raw Shopify customer fields exist only in this function's process memory. No customer payload,
// hash, IP or user-agent is copied to the delivery queue or returned by a merchant API.
export async function enrichConversionSignal(delivery: DeliveryClaim): Promise<MatchEvidence> {
  let browser: BrowserMatchInput = {};
  if (delivery.sourceEventId) {
    const source = await prisma.storefrontEvent.findFirst({
      where: {
        id: delivery.sourceEventId,
        storeId: delivery.storeId,
        adSharingAllowed: true,
        browserMatchExpiresAt: { gt: new Date() },
      },
      select: { browserMatchCiphertext: true },
    });
    if (source?.browserMatchCiphertext) {
      try {
        browser = JSON.parse(decryptSecret(source.browserMatchCiphertext)) as BrowserMatchInput;
      } catch {
        throw new ConversionProviderError(
          'Stored browser matching evidence is unavailable',
          false,
          'MATCH_EVIDENCE_INVALID',
        );
      }
    }
  }
  const config = (delivery.destination.configJson ?? {}) as ConversionDestinationConfig;
  if (
    !env.SHOPIFY_ENHANCED_MATCHING_APPROVED ||
    config.enhancedMatching !== true ||
    !delivery.sourceOrderId ||
    !delivery.shopifyOrderId
  )
    return browser;
  const store = await prisma.store.findUnique({
    where: { id: delivery.storeId },
    select: {
      myshopifyDomain: true,
      signalIdentityKey: { select: { secretCiphertext: true } },
      shopifyConnection: true,
    },
  });
  const connection = store?.shopifyConnection;
  if (
    !store ||
    !connection ||
    connection.status !== 'ACTIVE' ||
    !delivery.sourceGenerationAt ||
    connection.installedAt.getTime() !== delivery.sourceGenerationAt.getTime() ||
    !connection.scopes.includes('read_orders')
  )
    return browser;
  const accessToken = await auth.resolveAccessToken(store.myshopifyDomain, connection);
  let data: { order?: OrderMatch | null };
  try {
    data = await api.requestAdminGraphql({
      shop: store.myshopifyDomain,
      accessToken,
      apiVersion: connection.apiVersion,
      connectionId: connection.id,
      query:
        'query StrideConversionMatch($id: ID!) { order(id: $id) { id email phone customer { id } billingAddress { firstName lastName city provinceCode zip countryCodeV2 } } }',
      variables: { id: delivery.shopifyOrderId },
    });
  } catch {
    // Never persist a Shopify GraphQL error that could echo protected field values.
    throw new ConversionProviderError(
      'Shopify customer matching permission or data is unavailable',
      true,
      'SHOPIFY_MATCHING_UNAVAILABLE',
    );
  }
  if (!data.order || data.order.id !== delivery.shopifyOrderId) return browser;
  let externalId: string | undefined;
  if (data.order.customer && /^gid:\/\/shopify\/Customer\/\d+$/.test(data.order.customer.id)) {
    let ciphertext = store.signalIdentityKey?.secretCiphertext ?? null;
    if (!ciphertext) {
      const generated = encryptSecret(randomBytes(32).toString('base64url'));
      await prisma.$executeRaw`INSERT INTO "StoreSignalIdentityKey" ("storeId", "secretCiphertext") SELECT ${delivery.storeId}::uuid, ${generated} WHERE EXISTS (SELECT 1 FROM "ShopifyConnection" c WHERE c."storeId" = ${delivery.storeId}::uuid AND c."status" = 'ACTIVE' AND c."installedAt" = ${delivery.sourceGenerationAt}) ON CONFLICT ("storeId") DO NOTHING`;
      ciphertext =
        (
          await prisma.storeSignalIdentityKey.findUnique({
            where: { storeId: delivery.storeId },
            select: { secretCiphertext: true },
          })
        )?.secretCiphertext ?? null;
    }
    if (ciphertext)
      externalId = customerIdentity(
        decryptSecret(ciphertext),
        delivery.storeId,
        data.order.customer.id,
      );
  }
  delivery.customerIdentityKey = externalId;
  const address = data.order.billingAddress;
  return {
    ...browser,
    ...normalizeCustomerMatching({
      emails: [data.order.email ?? null],
      phones: [data.order.phone ?? null],
      firstName: address?.firstName,
      lastName: address?.lastName,
      city: address?.city,
      region: address?.provinceCode,
      postalCode: address?.zip,
      country: address?.countryCodeV2,
      externalId,
    }),
  };
}
