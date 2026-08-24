import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

const MAX_ATTEMPTS = 5;

export class TikTokWebhookRepository {
  findConnectionsByAdvertiserIds(advertiserIds: string[]) {
    if (advertiserIds.length === 0) return Promise.resolve([]);
    return prisma.tikTokAdvertiser.findMany({
      where: { advertiserId: { in: advertiserIds } },
      distinct: ['tiktokConnectionId'],
      select: { tiktokConnectionId: true, storeId: true },
    });
  }

  async createDelivery(input: {
    externalDeliveryId: string;
    connectionId: string | null;
    topic: string;
    triggeredAt: Date | null;
    apiVersion: string;
    payload: unknown;
  }) {
    const key = {
      provider_externalDeliveryId: {
        provider: 'TIKTOK' as const,
        externalDeliveryId: input.externalDeliveryId,
      },
    };
    const existing = await prisma.webhookDelivery.findUnique({ where: key });
    if (existing) return { delivery: existing, duplicate: true };
    try {
      const delivery = await prisma.webhookDelivery.create({
        data: {
          provider: 'TIKTOK',
          externalDeliveryId: input.externalDeliveryId,
          tiktokConnectionId: input.connectionId,
          topic: input.topic,
          apiVersion: input.apiVersion,
          triggeredAt: input.triggeredAt,
          status: input.connectionId ? 'QUEUED' : 'IGNORED',
          nextAttemptAt: input.connectionId ? new Date() : null,
          processedAt: input.connectionId ? null : new Date(),
          lastError: input.connectionId
            ? null
            : 'No configured TikTok advertiser matched this delivery',
          payload: input.payload as Prisma.InputJsonValue,
        },
      });
      return { delivery, duplicate: false };
    } catch (error) {
      const raced = await prisma.webhookDelivery.findUnique({ where: key });
      if (raced) return { delivery: raced, duplicate: true };
      throw error;
    }
  }

  async listDueDeliveryIds(limit: number, now: Date, staleBefore: Date): Promise<string[]> {
    const rows = await prisma.webhookDelivery.findMany({
      where: {
        provider: 'TIKTOK',
        attempts: { lt: MAX_ATTEMPTS },
        OR: [
          { status: 'QUEUED', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', processingStartedAt: { lte: staleBefore } },
        ],
      },
      orderBy: [{ nextAttemptAt: 'asc' }, { receivedAt: 'asc' }],
      select: { id: true },
      take: limit,
    });
    return rows.map((row) => row.id);
  }

  async tryClaim(id: string, now: Date, staleBefore: Date): Promise<boolean> {
    const result = await prisma.webhookDelivery.updateMany({
      where: {
        id,
        provider: 'TIKTOK',
        attempts: { lt: MAX_ATTEMPTS },
        OR: [
          { status: 'QUEUED', nextAttemptAt: { lte: now } },
          { status: 'FAILED', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', processingStartedAt: { lte: staleBefore } },
        ],
      },
      data: {
        status: 'PROCESSING',
        processingStartedAt: now,
        nextAttemptAt: null,
        lastError: null,
        attempts: { increment: 1 },
      },
    });
    return result.count === 1;
  }

  getDelivery(id: string) {
    return prisma.webhookDelivery.findUnique({
      where: { id },
      select: {
        id: true,
        topic: true,
        payload: true,
        attempts: true,
        tiktokConnectionId: true,
        tiktokConnection: { select: { storeId: true } },
      },
    });
  }

  markProcessed(id: string) {
    return prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'PROCESSED',
        processedAt: new Date(),
        processingStartedAt: null,
        nextAttemptAt: null,
        lastError: null,
      },
    });
  }

  markIgnored(id: string, reason: string) {
    return prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'IGNORED',
        processedAt: new Date(),
        processingStartedAt: null,
        nextAttemptAt: null,
        lastError: reason.slice(0, 4000),
      },
    });
  }

  markFailed(id: string, attempts: number, message: string) {
    const terminal = attempts >= MAX_ATTEMPTS;
    const delaySeconds = Math.min(300, 5 * 2 ** Math.max(0, attempts - 1));
    return prisma.webhookDelivery.update({
      where: { id },
      data: {
        status: 'FAILED',
        processingStartedAt: null,
        nextAttemptAt: terminal ? null : new Date(Date.now() + delaySeconds * 1000),
        lastError: message.slice(0, 4000),
      },
    });
  }
}
