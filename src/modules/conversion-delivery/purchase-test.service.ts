import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { billingService } from '../billing/billing.service.js';
import { verifyShopifyDevelopmentStore } from '../billing/shopify-development-store.js';
import { encryptSecret } from '../integrations/integration.utils.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';
import { storefrontEventKey } from './funnel.repository.js';

export async function requireDevelopmentStore(storeId: string) {
  const store = await prisma.store.findUnique({ where: { id: storeId }, select: { shopifyShopId: true } });
  if (!store || !(await verifyShopifyDevelopmentStore(storeId, store.shopifyShopId)))
    throw new AppError('Checkout tests are available only on verified Shopify development stores.', 403, 'TRACKING_TEST_DEV_STORE_REQUIRED');
}

export async function listPurchaseTestOrders(storeId: string) {
  await requireDevelopmentStore(storeId);
  return prisma.order.findMany({ where: { storeId, isTest: true, cancelledAt: null,
    shopifyCreatedAt: { gte: new Date(Date.now() - 7 * 86400_000) } },
    select: { id: true, name: true, shopifyCreatedAt: true, currentTotalAmount: true, currencyCode: true },
    orderBy: { shopifyCreatedAt: 'desc' }, take: 20 });
}

export async function queuePurchaseTest(storeId: string, destinationId: string, orderId: string, testEventCode?: string) {
  await requireDevelopmentStore(storeId);
  const repo = new ConversionDeliveryRepository();
  const destination = await repo.findDestinationWithSecret(storeId, destinationId);
  if (!destination || destination.status !== 'ACTIVE')
    throw new AppError('Enable sharing for this destination first.', 409, 'TRACKING_TEST_DESTINATION_REQUIRED');
  await billingService.requireAdProviderReadOnly(storeId, destination.provider);
  if (destination.provider !== 'GOOGLE_ADS' && !testEventCode)
    throw new AppError('Copy the test code from Events Manager first.', 400, 'TRACKING_TEST_CODE_REQUIRED');
  const order = await prisma.order.findFirst({ where: { id: orderId, storeId, isTest: true, cancelledAt: null }, select: { id: true } });
  if (!order) throw new AppError('Select a test-payment order from this store.', 404, 'TRACKING_TEST_ORDER_NOT_FOUND');
  const [candidate] = await repo.findPurchaseCandidates(1, orderId, true, storeId);
  if (!candidate || candidate.storeId !== storeId || !candidate.sourceEventId)
    throw new AppError('No permitted checkout record is linked to this order yet. Accept advertising consent, complete checkout and wait for Shopify synchronization.', 409, 'TRACKING_TEST_CHECKOUT_REQUIRED');
  const provider = destination.provider;
  const clickId = provider === 'META' ? candidate.metaClickId : provider === 'TIKTOK' ? candidate.tiktokClickId : candidate.googleClickId;
  const attributionEventAt = provider === 'META' ? candidate.metaClickEventAt : provider === 'TIKTOK' ? candidate.tiktokClickEventAt : candidate.googleClickEventAt;
  // Stable per-order identity prevents repeated button presses from creating duplicate purchases.
  const eventKey = storefrontEventKey(storeId, `test-purchase:${candidate.shopifyOrderId}`);
  await repo.enqueue({ storeId, destinationId, provider, eventKey, sourceOrderId: orderId,
    sourceEventId: candidate.sourceEventId, sourceGenerationAt: candidate.sourceGenerationAt,
    shopifyOrderId: candidate.shopifyOrderId, eventAt: candidate.eventAt,
    value: candidate.value, currencyCode: candidate.currencyCode, clickId,
    clickIdKind: provider === 'GOOGLE_ADS' ? candidate.googleClickIdKind : null,
    attributionEventAt, eventSourceUrl: candidate.eventSourceUrl,
    isTestDelivery: true, testCodeCiphertext: testEventCode ? encryptSecret(testEventCode) : null,
    testExpiresAt: new Date(Date.now() + 60 * 60_000) });
  const delivery = await prisma.conversionDelivery.findUnique({
    where: { destinationId_eventKey: { destinationId, eventKey } }, select: { id: true, status: true, reasonCode: true } });
  return { ...delivery, provider, testOnly: true, googleValidationOnly: provider === 'GOOGLE_ADS' };
}

export async function purchaseTestResult(storeId: string, id: string) {
  const row = await prisma.conversionDelivery.findFirst({ where: { id, storeId, isTestDelivery: true },
    select: { id: true, provider: true, status: true, reasonCode: true, lastError: true, providerRequestId: true, deliveredAt: true } });
  if (!row) throw new AppError('Checkout test not found.', 404, 'TRACKING_TEST_NOT_FOUND');
  return { ...row, testOnly: true, googleValidationOnly: row.provider === 'GOOGLE_ADS' };
}
