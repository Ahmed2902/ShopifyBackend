import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { env } from '../../config/env.js';
import { prisma } from '../../lib/prisma.js';
import { decryptSecret, encryptSecret } from '../integrations/integration.utils.js';
import { ShopifyRepository } from '../shopify/shopify.repository.js';
import { ShopifyApiService } from '../shopify/shared/shopify-api.service.js';
import { ShopifyAuthService } from '../shopify/shared/shopify-auth.service.js';
import type { BeforeConversionSend, ConversionDestinationConfig, DeliveryClaim } from './conversion-delivery.types.js';
import { customerIdentity, normalizeCustomerMatching, type BrowserMatchInput, type MatchEvidence } from './matching.js';
import { ConversionProviderError } from './providers/conversion-provider.error.js';

const repository = new ShopifyRepository();
const api = new ShopifyApiService(repository);
const auth = new ShopifyAuthService(repository, api);
type Address = { firstName?: string | null; lastName?: string | null; city?: string | null; provinceCode?: string | null; zip?: string | null; countryCodeV2?: string | null };
type OrderMatch = { id: string; email?: string | null; phone?: string | null; clientIp?: string | null; customer?: { id: string } | null; billingAddress?: Address | null; shippingAddress?: Address | null };

export function sameCheckoutProof(observed?: string | null, canonical?: string | null) {
  if (!observed || !canonical) return false;
  return timingSafeEqual(createHash('sha256').update(observed).digest(), createHash('sha256').update(canonical).digest());
}
export function shopifyOrderMatchingQuery(fields: readonly string[]) {
  const allowed = new Set(fields);
  const addressFields = [allowed.has('name') ? 'firstName lastName' : '', allowed.has('address') ? 'city provinceCode zip countryCodeV2' : ''].filter(Boolean).join(' ');
  return `query StrideConversionMatch($id: ID!) { order(id: $id) { id ${allowed.has('email') ? 'email' : ''} ${allowed.has('phone') ? 'phone' : ''} ${allowed.has('client_ip') ? 'clientIp' : ''} ${allowed.has('customer_id') ? 'customer { id }' : ''} ${addressFields ? `billingAddress { ${addressFields} } shippingAddress { ${addressFields} }` : ''} } }`;
}
// Protected fields and their hashes are retained only in this worker batch's memory.
export async function enrichConversionSignal(delivery: DeliveryClaim, beforeProtectedUse?: BeforeConversionSend): Promise<MatchEvidence> {
  let browser: BrowserMatchInput = {};
  const source = delivery.sourceEventId ? await prisma.storefrontEvent.findFirst({
    where: { id: delivery.sourceEventId, storeId: delivery.storeId, adSharingAllowed: true },
    select: { browserMatchCiphertext: true, browserMatchExpiresAt: true, shopifyCheckoutToken: true, eventAt: true },
  }) : null;
  if (source?.browserMatchCiphertext && source.browserMatchExpiresAt && source.browserMatchExpiresAt > new Date()) {
    try { browser = JSON.parse(decryptSecret(source.browserMatchCiphertext)) as BrowserMatchInput; }
    catch { throw new ConversionProviderError('Stored browser matching evidence is unavailable', false, 'MATCH_EVIDENCE_INVALID'); }
  }
  const config = (delivery.destination.configJson ?? {}) as ConversionDestinationConfig;
  if (!env.SHOPIFY_ENHANCED_MATCHING_APPROVED || config.enhancedMatching !== true || !delivery.sourceOrderId || !delivery.shopifyOrderId) return browser;
  if (!source?.shopifyCheckoutToken) {
    delivery.matchingReasonCode = 'CHECKOUT_PROOF_UNAVAILABLE'; return browser;
  }
  const store = await prisma.store.findUnique({ where: { id: delivery.storeId }, select: { myshopifyDomain: true, signalIdentityKey: { select: { secretCiphertext: true } }, shopifyConnection: true } });
  const connection = store?.shopifyConnection;
  if (!store || !connection || connection.status !== 'ACTIVE' || !delivery.sourceGenerationAt || connection.installedAt.getTime() !== delivery.sourceGenerationAt.getTime() || !connection.scopes.includes('read_orders')) return browser;
  if (connection.apiVersion < '2026-07') {
    delivery.matchingReasonCode = 'SHOPIFY_MATCHING_API_UPGRADE_REQUIRED'; return browser;
  }
  let data: { order?: OrderMatch | null };
  try {
    const accessToken = await auth.resolveAccessToken(store.myshopifyDomain, connection);
    await beforeProtectedUse?.();
    // Public collector order IDs alone cannot authorize another customer's matching data.
    const proof = await api.requestAdminGraphql<{ order?: { id: string; checkoutToken?: string | null } | null }>({
      shop: store.myshopifyDomain, accessToken, apiVersion: connection.apiVersion, connectionId: connection.id,
      query: 'query StrideCheckoutProof($id: ID!) { order(id: $id) { id checkoutToken } }',
      variables: { id: delivery.shopifyOrderId },
    });
    if (proof.order?.id !== delivery.shopifyOrderId || !sameCheckoutProof(source.shopifyCheckoutToken, proof.order.checkoutToken)) {
      delivery.matchingReasonCode = 'CHECKOUT_PROOF_UNAVAILABLE'; return browser;
    }
    await beforeProtectedUse?.();
    data = await api.requestAdminGraphql({ shop: store.myshopifyDomain, accessToken, apiVersion: connection.apiVersion, connectionId: connection.id,
      query: shopifyOrderMatchingQuery(env.SHOPIFY_ENHANCED_MATCHING_FIELDS), variables: { id: delivery.shopifyOrderId } });
  } catch (error) {
    // Preserve consent/billing errors; never persist provider messages that may echo protected data.
    if (error instanceof ConversionProviderError) throw error;
    throw new ConversionProviderError('Shopify customer matching permission or data is unavailable', true, 'SHOPIFY_MATCHING_UNAVAILABLE');
  }
  if (!data.order || data.order.id !== delivery.shopifyOrderId) return browser;
  let externalId: string | undefined;
  if (data.order.customer && /^gid:\/\/shopify\/Customer\/\d+$/.test(data.order.customer.id)) {
    let ciphertext = store.signalIdentityKey?.secretCiphertext ?? null;
    if (!ciphertext) {
      const generated = encryptSecret(randomBytes(32).toString('base64url'));
      ciphertext = await prisma.$transaction(async tx => {
        // Withdrawal and installation changes serialize against this same row.
        await tx.$queryRaw`SELECT "storeId" FROM "ShopifyConnection" WHERE "storeId" = ${delivery.storeId}::uuid FOR UPDATE`;
        await tx.$executeRaw`INSERT INTO "StoreSignalIdentityKey" ("storeId", "secretCiphertext") SELECT ${delivery.storeId}::uuid, ${generated} WHERE EXISTS (SELECT 1 FROM "ShopifyConnection" c WHERE c."storeId" = ${delivery.storeId}::uuid AND c."status" = 'ACTIVE' AND c."installedAt" = ${delivery.sourceGenerationAt}) ON CONFLICT ("storeId") DO NOTHING`;
        return (await tx.storeSignalIdentityKey.findUnique({ where: { storeId: delivery.storeId }, select: { secretCiphertext: true } }))?.secretCiphertext ?? null;
      });
    }
    if (ciphertext) externalId = customerIdentity(decryptSecret(ciphertext), delivery.storeId, data.order.customer.id);
  }
  delivery.customerIdentityKey = externalId;
  const address = data.order.billingAddress ?? data.order.shippingAddress;
  const clientIp = data.order.clientIp && isIP(data.order.clientIp) ? data.order.clientIp : undefined;
  return { ...browser, ...(clientIp ? { clientIp } : {}), ...normalizeCustomerMatching({
    emails: [data.order.email ?? null], phones: [data.order.phone ?? null], firstName: address?.firstName, lastName: address?.lastName,
    city: address?.city, region: address?.provinceCode, postalCode: address?.zip, country: address?.countryCodeV2, externalId,
  }) };
}
