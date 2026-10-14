import { prisma } from '../../lib/prisma.js';
import type { AdvertisingProvider } from '../../generated/prisma/client.js';
import { ConversionProviderError } from './providers/conversion-provider.error.js';
import { logger } from '../../lib/logger.js';
import { reportException } from '../../lib/monitoring.js';

export const MERCHANT_DISPATCH_INTERVAL_MS = 1_000;
export const CIRCUIT_FAILURE_THRESHOLD = 5;
export const CIRCUIT_PAUSE_MS = 60_000;
export async function acquireDispatch(storeId: string, provider: AdvertisingProvider, now = new Date()) {
  const circuit = await prisma.conversionProviderCircuit.findUnique({ where: { provider } });
  if (circuit?.blockedUntil && circuit.blockedUntil > now)
    throw new ConversionProviderError('Provider delivery is temporarily paused', true, 'PROVIDER_CIRCUIT_OPEN', circuit.blockedUntil.getTime() - now.getTime());
  const rows = await prisma.$queryRaw<Array<{ storeId: string }>>`
    INSERT INTO "ConversionDispatchBudget" ("storeId", provider, "nextAllowedAt")
    VALUES (${storeId}::uuid, ${provider}::"AdvertisingProvider", ${new Date(now.getTime() + MERCHANT_DISPATCH_INTERVAL_MS)})
    ON CONFLICT ("storeId", provider) DO UPDATE SET "nextAllowedAt" = EXCLUDED."nextAllowedAt"
    WHERE "ConversionDispatchBudget"."nextAllowedAt" <= ${now} RETURNING "storeId"`;
  if (!rows.length) throw new ConversionProviderError('Merchant delivery rate is temporarily limited', true,
    'MERCHANT_DISPATCH_LIMIT', MERCHANT_DISPATCH_INTERVAL_MS);
}
export async function recordProviderOutcome(provider: AdvertisingProvider, transientFailure: boolean) {
  if (!transientFailure) {
    await prisma.conversionProviderCircuit.upsert({ where: { provider }, create: { provider },
      update: { failures: 0, blockedUntil: null } });
    return;
  }
  await prisma.$executeRaw`
    INSERT INTO "ConversionProviderCircuit" (provider, failures, "blockedUntil")
    VALUES (${provider}::"AdvertisingProvider", 1, NULL)
    ON CONFLICT (provider) DO UPDATE SET failures = "ConversionProviderCircuit".failures + 1,
      "blockedUntil" = CASE WHEN "ConversionProviderCircuit".failures + 1 >= ${CIRCUIT_FAILURE_THRESHOLD}
        THEN NOW() + INTERVAL '60 seconds' ELSE "ConversionProviderCircuit"."blockedUntil" END`;
}
export async function deliveryHealth(storeId?: string) {
  const rows = await prisma.conversionDelivery.groupBy({
    by: ['provider', 'status', 'reasonCode'],
    where: { ...(storeId ? { storeId } : {}), isTestDelivery: false, eventName: 'PURCHASE',
      createdAt: { gte: new Date(Date.now() - 30 * 86400_000) } },
    _count: { _all: true }, _min: { nextAttemptAt: true },
  });
  const providerRows = ['META', 'TIKTOK', 'GOOGLE_ADS'].map(provider => {
    const items = rows.filter(r => r.provider === provider);
    const count = (status: string) => items.filter(r => r.status === status).reduce((n, r) => n + r._count._all, 0);
    const shadow = items.filter(r => r.reasonCode === 'SHADOW_MODE').reduce((n, r) => n + r._count._all, 0);
    const eligible = items.filter(r => r.status !== 'SKIPPED' || r.reasonCode === 'SHADOW_MODE').reduce((n, r) => n + r._count._all, 0);
    const oldest = items.filter(r => ['PENDING', 'RETRY', 'PROCESSING'].includes(r.status)).flatMap(r => r._min.nextAttemptAt ? [r._min.nextAttemptAt] : []).sort((a, b) => +a - +b)[0];
    const acknowledged = count('DELIVERED');
    const dead = count('DEAD');
    const credential = items.filter(r => r.reasonCode === 'CONNECTION_REAUTH_REQUIRED').reduce((n, r) => n + r._count._all, 0);
    return { provider, eligible, acknowledged, shadow, pending: count('PENDING') + count('PROCESSING'), retrying: count('RETRY'),
      terminal: dead, excluded: count('SKIPPED') - shadow, acceptanceRate: eligible ? acknowledged / eligible : null,
      alerts: [ ...(credential ? ['CREDENTIAL_RECONNECT_REQUIRED'] : []),
        ...(dead >= 5 && dead / Math.max(1, acknowledged + dead) >= .1 ? ['DELIVERY_FAILURE_RATE'] : []),
        ...(oldest && +oldest < Date.now() - 10 * 60_000 ? ['DELIVERY_QUEUE_STALE'] : []) ] };
  });
  return { windowDays: 30, interpretation: 'Recorded eligible purchases and provider acceptance, not customer matching or ad attribution', items: providerRows };
}
let lastAlertAt = 0;
export async function reportDeliveryAlerts() {
  if (Date.now() - lastAlertAt < 300_000) return;
  lastAlertAt = Date.now();
  const health = await deliveryHealth();
  for (const row of health.items) if (row.alerts.length) {
    logger.warn({ provider: row.provider, alerts: row.alerts, terminal: row.terminal }, 'Conversion delivery requires attention');
    reportException(new Error('Conversion delivery operational alert'));
  }
}
