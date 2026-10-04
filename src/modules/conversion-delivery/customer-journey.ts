import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/app-error.js';
import { classifyAcquisition } from '../pixel/acquisition.js';

// Only exact, canonical customer/order links expand a customer journey. An anonymous browser
// session on a shared device is never enough to merge two Shopify customers.
export async function customerOrderJourney(storeId: string, orderId: string) {
  const now = new Date();
  const link = await prisma.storefrontCustomerLink.findFirst({
    where: { storeId, sourceOrderId: orderId, expiresAt: { gt: now } },
    select: { customerKey: true },
  });
  if (!link)
    throw new AppError(
      'No permitted canonical customer relationship is available for this order',
      404,
      'CUSTOMER_JOURNEY_UNAVAILABLE',
    );
  const orders = await prisma.storefrontCustomerLink.findMany({
    where: {
      storeId,
      customerKey: link.customerKey,
      expiresAt: { gt: now },
      order: { shopifyCreatedAt: { gte: new Date(now.getTime() - 30 * 86400_000) } },
    },
    select: {
      sourceOrderId: true,
      order: { select: { shopifyOrderId: true, shopifyCreatedAt: true } },
    },
    orderBy: { order: { shopifyCreatedAt: 'asc' } },
    take: 101,
  });
  const sessions = await prisma.storefrontSession.findMany({
    where: {
      storeId,
      orderId: { in: orders.slice(0, 100).map((o) => o.sourceOrderId) },
      orderLinkStatus: 'LINKED',
      retentionExpiresAt: { gt: now },
    },
    orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
    take: 1001,
    select: {
      id: true,
      startedAt: true,
      endedAt: true,
      orderId: true,
      touches: {
        orderBy: { ordinal: 'asc' },
        take: 100,
        select: {
          eventAt: true,
          metaClickId: true,
          googleClickId: true,
          googleBraidedClickId: true,
          googleWebBraidedClickId: true,
          tiktokClickId: true,
          utmSource: true,
          utmMedium: true,
          utmCampaign: true,
          referrerUrl: true,
          landingPageUrl: true,
          metaAdExternalId: true,
          metaAdSetExternalId: true,
          metaCampaignExternalId: true,
        },
      },
    },
  });
  const touches = sessions
    .slice(0, 1000)
    .flatMap((session) =>
      session.touches.map((touch) => ({
        eventAt: touch.eventAt,
        ...classifyAcquisition(touch),
        orderId: session.orderId,
      })),
    )
    .sort((a, b) => a.eventAt.getTime() - b.eventAt.getTime());
  return {
    evidence: 'EXACT_SHOPIFY_CUSTOMER_ORDER',
    interpretation:
      'Observed customer-linked touch evidence, not causal or incremental attribution. Unlinked anonymous sessions are excluded.',
    windowDays: 30,
    truncated:
      orders.length > 100 ||
      sessions.length > 1000 ||
      sessions.some((s) => s.touches.length === 100),
    orders: orders
      .slice(0, 100)
      .map((o) => ({
        orderId: o.sourceOrderId,
        shopifyOrderId: o.order.shopifyOrderId,
        purchasedAt: o.order.shopifyCreatedAt,
      })),
    touches,
    firstTouch: touches[0] ?? null,
    lastTouch: touches.at(-1) ?? null,
    assistedTouches: touches.slice(0, -1),
    paidTouches: touches.filter((t) => t.paid === true).length,
    organicTouches: touches.filter((t) => ['ORGANIC_SEARCH', 'ORGANIC_SOCIAL'].includes(t.channel))
      .length,
  };
}
