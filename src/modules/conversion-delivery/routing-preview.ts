import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/app-error.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';
import { ROUTING_POLICY, ROUTING_WINDOW_DAYS, type RoutingSummary } from './source-routing.js';

// A read-only preview never creates a delivery, accepts synthetic click IDs, or changes consent.
export async function purchaseRoutingPreview(storeId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { storeId, id: orderId },
    select: {
      id: true,
      name: true,
      isTest: true,
      cancelledAt: true,
      processedAt: true,
      shopifyCreatedAt: true,
    },
  });
  if (!order) throw new AppError('Order not found in this store', 404, 'ORDER_NOT_FOUND');
  const repo = new ConversionDeliveryRepository();
  const [[candidate], destinations, deliveries] = await Promise.all([
    repo.findPurchaseCandidates(1, orderId, order.isTest, storeId),
    prisma.conversionDestination.findMany({
      where: { storeId, status: 'ACTIVE' },
      select: { provider: true },
    }),
    prisma.conversionDelivery.findMany({
      where: { storeId, sourceOrderId: orderId, isTestDelivery: false },
      select: { provider: true, status: true, deliveredAt: true },
    }),
  ]);
  const active = new Set(destinations.map((d) => d.provider));
  const routing: Omit<RoutingSummary, 'reason'> & {
    reason: RoutingSummary['reason'] | 'CHECKOUT_EVIDENCE_UNAVAILABLE';
  } = candidate?.routing ?? {
    policy: ROUTING_POLICY,
    windowDays: ROUTING_WINDOW_DAYS,
    eligibleProviders: [],
    touches: [],
    lastPaidTouch: null,
    reason: 'CHECKOUT_EVIDENCE_UNAVAILABLE',
    ambiguousTouches: 0,
  };
  const expired =
    (order.processedAt ?? order.shopifyCreatedAt).getTime() < Date.now() - 7 * 86400_000;
  return {
    order: { id: order.id, name: order.name, isTest: order.isTest },
    routing,
    // A matching/entitlement check still happens before sending. Don't label this ready-to-deliver.
    channels: (['META', 'TIKTOK', 'GOOGLE_ADS'] as const).map((provider) => ({
      provider,
      sourceEligible: routing.eligibleProviders.includes(provider),
      enabled: active.has(provider),
      decision: order.cancelledAt
        ? 'ORDER_CANCELLED'
        : expired
          ? 'ORDER_TOO_OLD'
          : !candidate
            ? 'CHECKOUT_EVIDENCE_UNAVAILABLE'
            : !routing.eligibleProviders.includes(provider)
              ? routing.reason
              : !active.has(provider)
                ? 'DESTINATION_DISABLED'
                : 'SOURCE_ELIGIBLE',
      deliveries: deliveries.filter((d) => d.provider === provider),
    })),
    interpretation:
      'Source eligibility only. Consent, matching, account access and plan are checked again before delivery. Test mode is separate from live routing; platform attribution is not established.',
  };
}
