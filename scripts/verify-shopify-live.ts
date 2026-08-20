import { prisma } from '../src/lib/prisma.js';
import { shopifyReadService, shopifyService } from '../src/modules/shopify/shopify.module.js';

const POLL_INTERVAL_MS = 5_000;
const DEFAULT_BACKFILL_TIMEOUT_MS = 30 * 60_000;

function requiredStoreId(): string {
  const storeId = process.env.SHOPIFY_VERIFY_STORE_ID?.trim();
  if (!storeId) {
    throw new Error('SHOPIFY_VERIFY_STORE_ID is required');
  }
  return storeId;
}

function timeoutMs(): number {
  const raw = process.env.SHOPIFY_VERIFY_BACKFILL_TIMEOUT_MS;
  if (!raw) return DEFAULT_BACKFILL_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('SHOPIFY_VERIFY_BACKFILL_TIMEOUT_MS must be a positive number');
  }
  return value;
}

function logStep(step: string, result: unknown): void {
  console.log(`\n=== ${step} ===`);
  console.log(JSON.stringify(result, null, 2));
}

async function verifyBackfill(storeId: string) {
  const started = await shopifyService.startOrderHistoryBackfill(storeId);
  logStep('Order history backfill started', started);

  const deadline = Date.now() + timeoutMs();
  while (Date.now() < deadline) {
    const status = await shopifyService.getOrderHistoryBackfill(storeId, started.syncRunId);
    if (status.status !== 'RUNNING') return status;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  throw new Error('Timed out waiting for Shopify order-history backfill');
}

async function main() {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Live Shopify verification is disabled when NODE_ENV=production');
  }

  const storeId = requiredStoreId();
  const before = await shopifyReadService.getStatus(storeId);
  logStep('Before verification', before);

  const sync = await shopifyService.syncStoreData(storeId);
  logStep('Catalog + inventory sync', sync);

  if (process.env.SHOPIFY_VERIFY_BACKFILL === 'true') {
    const backfill = await verifyBackfill(storeId);
    logStep('Order history backfill completed', backfill);
    if (backfill.status !== 'SUCCEEDED') {
      throw new Error(`Order-history backfill ended with ${backfill.status}`);
    }
  }

  const reconciliation = await shopifyService.reconcileStoreData(storeId);
  logStep('Periodic-style reconciliation', reconciliation);

  const after = await shopifyReadService.getStatus(storeId);
  logStep('After verification', after);

  console.log('\nShopify live verification completed without exposing stored credentials.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
