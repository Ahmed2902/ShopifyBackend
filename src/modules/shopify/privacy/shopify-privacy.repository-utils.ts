import type { Prisma } from '../../../generated/prisma/client.js';

export const PRIVACY_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 120_000 } as const;

const ORDER_WEBHOOK_TOPICS = ['orders/create', 'orders/updated', 'refunds/create'] as const;
const WEBHOOK_SCAN_PAGE_SIZE = 250;

type PrivacyQueryClient = Pick<Prisma.TransactionClient, 'shopifyConnection' | 'webhookDelivery'>;

export type MatchingOrderWebhookDelivery = {
  id: string;
  topic: string;
  payload: Prisma.JsonValue;
  receivedAt: Date;
};

export function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

export function uniqueStrings(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizeOrderReference(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  if (text.startsWith('gid://shopify/Order/')) return text;
  return /^\d+$/.test(text) ? `gid://shopify/Order/${text}` : null;
}

function payloadReferencesOrder(
  topic: string,
  payload: Prisma.JsonValue,
  requestedOrderIds: Set<string>,
): boolean {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return false;
  const record = payload as Record<string, unknown>;
  const values =
    topic === 'refunds/create'
      ? [record.order_id]
      : [record.admin_graphql_api_id, record.id];

  return values.some((value) => {
    const normalized = normalizeOrderReference(value);
    return normalized ? requestedOrderIds.has(normalized) : false;
  });
}

export async function findMatchingOrderWebhookDeliveries(
  client: PrivacyQueryClient,
  storeId: string,
  requestedOrderIds: string[],
): Promise<MatchingOrderWebhookDelivery[]> {
  if (requestedOrderIds.length === 0) return [];
  const connection = await client.shopifyConnection.findUnique({
    where: { storeId },
    select: { id: true },
  });
  if (!connection) return [];

  const wanted = new Set(requestedOrderIds);
  const matches: MatchingOrderWebhookDelivery[] = [];
  let cursor: string | null = null;

  while (true) {
    // Keep this explicit rather than relying on Prisma's recursive generic inference around
    // cursor pagination. TypeScript can otherwise report TS7022 for this self-updating loop.
    const page: MatchingOrderWebhookDelivery[] = await client.webhookDelivery.findMany({
      where: {
        shopifyConnectionId: connection.id,
        topic: { in: [...ORDER_WEBHOOK_TOPICS] },
      },
      orderBy: { id: 'asc' },
      take: WEBHOOK_SCAN_PAGE_SIZE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: { id: true, topic: true, payload: true, receivedAt: true },
    });
    if (page.length === 0) break;

    for (const delivery of page) {
      if (payloadReferencesOrder(delivery.topic, delivery.payload, wanted)) {
        matches.push(delivery);
      }
    }

    cursor = page.at(-1)!.id;
    if (page.length < WEBHOOK_SCAN_PAGE_SIZE) break;
  }

  return matches;
}
