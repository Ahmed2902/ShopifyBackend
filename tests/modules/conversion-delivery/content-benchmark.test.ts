import { expect, it, vi } from 'vitest';
import { performance } from 'node:perf_hooks';
import { writeFileSync } from 'node:fs';
import { prepareConversionContents as before } from '../../../src/modules/conversion-delivery/conversion-content.before-benchmark.js';
import { prepareConversionContents as after } from '../../../src/modules/conversion-delivery/conversion-content.js';
const mocks = vi.hoisted(() => ({ order: vi.fn(), events: vi.fn(), meta: vi.fn() }));
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: { order: { findMany: mocks.order }, storefrontEvent: { findMany: mocks.events }, catalogItemVariantMapping: { findMany: mocks.meta }, tikTokCatalogItemVariantMapping: { findMany: vi.fn().mockResolvedValue([]) } } }));
it('benchmarks content preparation with identical tenant-scoped output', async () => {
  const count = 100;
  const orders = Array.from({ length: count }, (_, i) => ({ id: 'order-'+i, storeId: 'store-'+i, lineItems: Array.from({ length: 30 }, (_, j) => ({ shopifyVariantId: 'variant-'+j, quantity: 2, discountedUnitPriceAfterAllDiscounts: '10', originalUnitPrice: '12' })) }));
  const mappings = orders.flatMap((o) => o.lineItems.map((l) => ({ variant: { shopifyVariantId: l.shopifyVariantId, storeId: o.storeId }, catalogItem: { retailerId: o.storeId+'-'+l.shopifyVariantId, catalog: { id: 'catalog-'+o.storeId, storeId: o.storeId } } })));
  mocks.order.mockResolvedValue(orders); mocks.events.mockResolvedValue([]); mocks.meta.mockResolvedValue(mappings);
  const claims = orders.map((o) => ({ id:o.id, sourceOrderId:o.id, storeId:o.storeId, provider:'META', eventName:'PURCHASE', destination:{ configJson:{ catalogId:'catalog-'+o.storeId } } }));
  const times: Record<string,number[]>={before:[],after:[]};
  for (let warmup=0;warmup<5;warmup++) { await before(structuredClone(claims) as never); await after(structuredClone(claims) as never); }
  for (let i=0;i<20;i++) for (const [label, fn] of [['before',before],['after',after]] as const) { const copy=structuredClone(claims); const start=performance.now(); await fn(copy as never); times[label]!.push(performance.now()-start); }
  const a=structuredClone(claims),b=structuredClone(claims); await before(a as never); await after(b as never); expect(b).toEqual(a);
  const median=(values:number[]) => [...values].sort((a,b)=>a-b)[Math.floor(values.length/2)]!;
  writeFileSync('/tmp/metrico-content-benchmark.json',JSON.stringify({ scenario:'100 claims across 100 tenants, 30 items each, 3000 catalog mappings; mocked database I/O; preparation CPU only', samples:20, beforeMedianMs:median(times.before!),afterMedianMs:median(times.after!),equalOutput:true,times },null,2));
});
