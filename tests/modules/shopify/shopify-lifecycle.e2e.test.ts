import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../src/config/env.js';
import { prisma } from '../../../src/lib/prisma.js';
import { IntegrationRepository } from '../../../src/modules/integrations/integration.repository.js';
import { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
import { ShopifyOrderRepository } from '../../../src/modules/shopify/order/shopify-order.repository.js';
import { ShopifyReadRepository } from '../../../src/modules/shopify/read/shopify-read.repository.js';
import { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

const ids = {
  shop: 'gid://shopify/Shop/9100',
  product: 'gid://shopify/Product/9200',
  variant: 'gid://shopify/ProductVariant/9300',
  inventoryItem: 'gid://shopify/InventoryItem/9400',
  location: 'gid://shopify/Location/9500',
  order: 'gid://shopify/Order/9600',
  lineItem: 'gid://shopify/LineItem/9700',
  refund: 'gid://shopify/Refund/9800',
  refundLine: 'gid://shopify/RefundLineItem/9900',
  bulk: 'gid://shopify/BulkOperation/10000',
} as const;
const shopDomain = 'lifecycle-store.myshopify.com';
const bulkUrl = 'https://storage.example.test/orders.jsonl';

function money(amount: string) {
  return {
    shopMoney: { amount, currencyCode: 'USD' },
    presentmentMoney: { amount, currencyCode: 'USD' },
  };
}

function orderHeader(totalAmount: string) {
  return {
    id: ids.order,
    name: '#1001',
    createdAt: '2026-08-20T08:00:00.000Z',
    processedAt: '2026-08-20T08:00:05.000Z',
    updatedAt: '2026-08-20T12:00:00.000Z',
    cancelledAt: null,
    cancelReason: null,
    sourceName: 'web',
    test: false,
    currencyCode: 'USD',
    presentmentCurrencyCode: 'USD',
    displayFinancialStatus: 'PARTIALLY_REFUNDED',
    displayFulfillmentStatus: 'FULFILLED',
    currentSubtotalLineItemsQuantity: 1,
    currentSubtotalPriceSet: money(totalAmount),
    currentShippingPriceSet: money('0.00'),
    currentTotalDiscountsSet: money('0.00'),
    currentTotalTaxSet: money('0.00'),
    currentTotalPriceSet: money(totalAmount),
    discountCodes: [],
    refunds: [
      {
        id: ids.refund,
        createdAt: '2026-08-20T10:00:00.000Z',
        processedAt: '2026-08-20T10:00:05.000Z',
        updatedAt: '2026-08-20T10:00:05.000Z',
        totalRefundedSet: money('10.00'),
      },
    ],
  };
}

function orderLine(totalAmount: string) {
  return {
    id: ids.lineItem,
    sku: 'HOODIE-BLK-L',
    title: 'Black Hoodie',
    variantTitle: 'Large',
    quantity: 1,
    currentQuantity: 1,
    refundableQuantity: 0,
    requiresShipping: true,
    restockable: true,
    product: { id: ids.product },
    variant: { id: ids.variant },
    originalUnitPriceSet: money(totalAmount),
    originalTotalSet: money(totalAmount),
    discountedTotalSet: money(totalAmount),
    discountedUnitPriceAfterAllDiscountsSet: money(totalAmount),
    totalDiscountSet: money('0.00'),
    discountAllocations: [],
  };
}

function inventoryLevel(available: number) {
  return {
    id: 'gid://shopify/InventoryLevel/1',
    updatedAt: '2026-08-20T12:00:00.000Z',
    item: { id: ids.inventoryItem },
    location: { id: ids.location },
    quantities: [
      { name: 'available', quantity: available },
      { name: 'incoming', quantity: 2 },
      { name: 'committed', quantity: 1 },
      { name: 'damaged', quantity: 0 },
      { name: 'on_hand', quantity: available + 1 },
      { name: 'quality_control', quantity: 0 },
      { name: 'reserved', quantity: 0 },
      { name: 'safety_stock', quantity: 1 },
    ],
  };
}

function refundDetail() {
  return {
    id: ids.refund,
    createdAt: '2026-08-20T10:00:00.000Z',
    processedAt: '2026-08-20T10:00:05.000Z',
    updatedAt: '2026-08-20T10:00:05.000Z',
    totalRefundedSet: money('10.00'),
    refundLineItems: {
      nodes: [
        {
          id: ids.refundLine,
          quantity: 1,
          restocked: false,
          restockType: 'NO_RESTOCK',
          lineItem: { id: ids.lineItem },
          location: { id: ids.location },
          priceSet: money('10.00'),
          subtotalSet: money('10.00'),
          totalTaxSet: money('0.00'),
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

interface ProviderState {
  inventoryAvailable: number;
  orderTotal: string;
  returnUpdatedOrder: boolean;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function buildProviderFetch(state: ProviderState) {
  return vi.fn(async (urlInput: string | URL | Request, init?: RequestInit) => {
    const url = String(urlInput);
    if (url === bulkUrl) {
      const root = JSON.stringify(orderHeader('59.99'));
      const line = JSON.stringify({ ...orderLine('59.99'), __parentId: ids.order });
      return new Response(`${root}\n${line}\n`, {
        status: 200,
        headers: { 'content-type': 'application/jsonl' },
      });
    }

    const body = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
    const query = body.query ?? '';

    if (query.includes('AppInstallationShop')) {
      return jsonResponse({
        data: {
          shop: {
            id: ids.shop,
            name: 'Lifecycle Store',
            myshopifyDomain: shopDomain,
            currencyCode: 'USD',
            ianaTimezone: 'UTC',
            primaryDomain: { host: 'example.test', url: 'https://example.test' },
            enabledPresentmentCurrencies: ['USD'],
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        },
      });
    }

    if (query.includes('CatalogProducts')) {
      return jsonResponse({
        data: {
          products: {
            nodes: [
              {
                id: ids.product,
                title: 'Black Hoodie',
                handle: 'black-hoodie',
                productType: 'Hoodie',
                vendor: 'Temper',
                tags: ['core'],
                status: 'ACTIVE',
                totalInventory: state.inventoryAvailable,
                tracksInventory: true,
                publishedAt: '2026-01-02T00:00:00.000Z',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-08-20T12:00:00.000Z',
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (query.includes('CatalogVariants')) {
      return jsonResponse({
        data: {
          productVariants: {
            nodes: [
              {
                id: ids.variant,
                title: 'Large',
                displayName: 'Black Hoodie - Large',
                sku: 'HOODIE-BLK-L',
                barcode: '123456789',
                price: '59.99',
                compareAtPrice: null,
                position: 1,
                availableForSale: state.inventoryAvailable > 0,
                inventoryQuantity: state.inventoryAvailable,
                inventoryPolicy: 'DENY',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-08-20T12:00:00.000Z',
                selectedOptions: [{ name: 'Size', value: 'L' }],
                product: { id: ids.product },
                inventoryItem: {
                  id: ids.inventoryItem,
                  sku: 'HOODIE-BLK-L',
                  tracked: true,
                  requiresShipping: true,
                  createdAt: '2026-01-01T00:00:00.000Z',
                  updatedAt: '2026-08-20T12:00:00.000Z',
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (query.includes('InventoryLocations')) {
      return jsonResponse({
        data: {
          locations: {
            nodes: [
              {
                id: ids.location,
                name: 'Main Warehouse',
                isActive: true,
                fulfillsOnlineOrders: true,
                shipsInventory: true,
                hasActiveInventory: true,
                deactivatedAt: null,
                address: { city: 'Cairo', country: 'Egypt', countryCode: 'EG' },
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-08-20T12:00:00.000Z',
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (query.includes('LocationInventory')) {
      return jsonResponse({
        data: {
          location: {
            inventoryLevels: {
              nodes: [inventoryLevel(state.inventoryAvailable)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }

    if (query.includes('WebhookInventoryLevel')) {
      return jsonResponse({
        data: { inventoryItem: { inventoryLevel: inventoryLevel(state.inventoryAvailable) } },
      });
    }

    if (query.includes('RunBulkQuery')) {
      return jsonResponse({
        data: {
          bulkOperationRunQuery: {
            bulkOperation: { id: ids.bulk, status: 'CREATED' },
            userErrors: [],
          },
        },
      });
    }

    if (query.includes('BulkOperationStatus')) {
      return jsonResponse({
        data: {
          bulkOperation: {
            id: ids.bulk,
            status: 'COMPLETED',
            errorCode: null,
            objectCount: '2',
            url: bulkUrl,
            partialDataUrl: null,
          },
        },
      });
    }

    if (query.includes('RefundDetails')) {
      return jsonResponse({ data: { refund: refundDetail() } });
    }

    if (query.includes('UpdatedOrders')) {
      return jsonResponse({
        data: {
          orders: {
            nodes: state.returnUpdatedOrder
              ? [{ id: ids.order, updatedAt: '2026-08-20T12:00:00.000Z' }]
              : [],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });
    }

    if (query.includes('WebhookOrder')) {
      return jsonResponse({
        data: {
          order: {
            ...orderHeader(state.orderTotal),
            lineItems: {
              nodes: [orderLine(state.orderTotal)],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        },
      });
    }

    throw new Error(`Unhandled Shopify test request: ${query.slice(0, 80)}`);
  });
}

async function createStore() {
  const store = await prisma.store.create({
    data: {
      shopifyShopId: ids.shop,
      name: 'Lifecycle Store',
      myshopifyDomain: shopDomain,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
      shopifyConnection: {
        create: {
          status: 'ACTIVE',
          accessTokenCiphertext: encryptSecret('lifecycle-access-token'),
          scopes: ['read_products', 'read_inventory', 'read_locations', 'read_orders'],
          apiVersion: '2026-07',
        },
      },
    },
    select: { id: true, myshopifyDomain: true, shopifyConnection: { select: { id: true } } },
  });
  createdStoreIds.push(store.id);
  return store;
}

function webhookSignature(rawBody: Buffer) {
  return createHmac('sha256', env.SHOPIFY_CLIENT_SECRET).update(rawBody).digest('base64');
}

async function deleteStore(storeId: string) {
  const connection = await prisma.shopifyConnection.findUnique({
    where: { storeId },
    select: { id: true },
  });

  const orders = await prisma.order.findMany({ where: { storeId }, select: { id: true } });
  const orderIds = orders.map((order) => order.id);
  const refunds = orderIds.length
    ? await prisma.refund.findMany({ where: { orderId: { in: orderIds } }, select: { id: true } })
    : [];
  const refundIds = refunds.map((refund) => refund.id);
  if (refundIds.length) {
    await prisma.refundLineItem.deleteMany({ where: { refundId: { in: refundIds } } });
  }
  if (orderIds.length) {
    await prisma.refund.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.orderLineItem.deleteMany({ where: { orderId: { in: orderIds } } });
    await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }

  const items = await prisma.inventoryItem.findMany({ where: { storeId }, select: { id: true } });
  const itemIds = items.map((item) => item.id);
  if (itemIds.length) {
    await prisma.inventorySnapshot.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
    await prisma.inventoryLevelCurrent.deleteMany({ where: { inventoryItemId: { in: itemIds } } });
  }
  await prisma.inventoryItem.deleteMany({ where: { storeId } });

  const variants = await prisma.productVariant.findMany({ where: { storeId }, select: { id: true } });
  const variantIds = variants.map((variant) => variant.id);
  if (variantIds.length) {
    await prisma.variantOption.deleteMany({ where: { variantId: { in: variantIds } } });
    await prisma.variantCost.deleteMany({ where: { variantId: { in: variantIds } } });
  }
  await prisma.productVariant.deleteMany({ where: { storeId } });
  await prisma.product.deleteMany({ where: { storeId } });
  await prisma.location.deleteMany({ where: { storeId } });

  if (connection) {
    await prisma.externalPayload.deleteMany({
      where: {
        OR: [
          { syncRun: { shopifyConnectionId: connection.id } },
          { webhookDelivery: { shopifyConnectionId: connection.id } },
        ],
      },
    });
    await prisma.webhookDelivery.deleteMany({ where: { shopifyConnectionId: connection.id } });
    await prisma.syncRun.deleteMany({ where: { shopifyConnectionId: connection.id } });
    await prisma.shopifyConnection.delete({ where: { id: connection.id } });
  }
  await prisma.store.deleteMany({ where: { id: storeId } });
}

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const storeId of createdStoreIds.splice(0)) await deleteStore(storeId);
});

describeDatabase('Shopify persisted lifecycle', () => {
  it('keeps sync, history, webhooks, reconciliation and frontend reads consistent end to end', async () => {
    const store = await createStore();
    const state: ProviderState = {
      inventoryAvailable: 9,
      orderTotal: '59.99',
      returnUpdatedOrder: false,
    };
    const fetchMock = buildProviderFetch(state);
    vi.stubGlobal('fetch', fetchMock);

    const integrationService = new IntegrationService(new IntegrationRepository());
    const service = new ShopifyService(
      new ShopifyRepository(),
      integrationService,
      new ShopifyOrderRepository(),
    );
    const readRepository = new ShopifyReadRepository();

    const initialSync = await service.syncStoreData(store.id);
    expect(initialSync).toMatchObject({
      status: 'SUCCEEDED',
      breakdown: { products: 1, variants: 1, locations: 1, inventoryLevels: 1 },
    });

    const products = await readRepository.listProducts(store.id, { page: 1, limit: 50 });
    expect(products).toMatchObject({
      total: 1,
      items: [{ title: 'Black Hoodie', availableInventory: 9, minPrice: '59.99' }],
    });

    const backfill = await service.startOrderHistoryBackfill(store.id);
    expect(backfill).toMatchObject({
      status: 'RUNNING',
      providerOperationId: ids.bulk,
      historyAccess: 'LAST_60_DAYS',
    });
    const completedBackfill = await service.getOrderHistoryBackfill(store.id, backfill.syncRunId);
    expect(completedBackfill).toMatchObject({
      status: 'SUCCEEDED',
      recordsWritten: 4,
      breakdown: { orders: 1, lineItems: 1, refunds: 1, refundLineItems: 1 },
    });

    const orders = await readRepository.listOrders(store.id, {
      page: 1,
      limit: 50,
      isTest: false,
    });
    expect(orders).toMatchObject({
      total: 1,
      items: [{ name: '#1001', currentTotalAmount: '59.99', refundCount: 1 }],
    });
    const orderDetail = await readRepository.getOrder(store.id, orders.items[0]!.id);
    expect(orderDetail).toMatchObject({
      currentTotalAmount: '59.99',
      refunds: [{ totalRefunded: '10', lineItems: [{ quantity: 1, price: '10' }] }],
    });

    state.inventoryAvailable = 3;
    const inventoryBody = Buffer.from(
      JSON.stringify({ inventory_item_id: 9400, location_id: 9500 }),
      'utf8',
    );
    const webhookHeaders = {
      hmac: webhookSignature(inventoryBody),
      topic: 'inventory_levels/update',
      shopDomain: store.myshopifyDomain,
      webhookId: 'inventory-delivery-1',
      apiVersion: '2026-07',
      triggeredAt: '2026-08-20T13:00:00.000Z',
    };
    const firstDelivery = await service.receiveWebhook(webhookHeaders, inventoryBody);
    const duplicateDelivery = await service.receiveWebhook(webhookHeaders, inventoryBody);
    expect(firstDelivery).toMatchObject({ duplicate: false, queued: true });
    expect(duplicateDelivery).toMatchObject({ duplicate: true, queued: false });

    expect(await service.processWebhookQueue()).toEqual({ claimed: 1, processed: 1 });
    const inventoryAfterWebhook = await readRepository.listInventory(store.id, {
      page: 1,
      limit: 50,
    });
    expect(inventoryAfterWebhook.items[0]?.available).toBe(3);
    const snapshotsAfterWebhook = await prisma.inventorySnapshot.findMany({
      where: { inventoryItem: { storeId: store.id } },
      orderBy: { createdAt: 'asc' },
      select: { source: true, available: true },
    });
    expect(snapshotsAfterWebhook).toEqual([
      { source: 'INITIAL_SYNC', available: 9 },
      { source: 'WEBHOOK_RECONCILIATION', available: 3 },
    ]);

    state.inventoryAvailable = 2;
    state.orderTotal = '49.99';
    state.returnUpdatedOrder = true;
    const reconciliation = await service.reconcileStoreData(store.id);
    expect(reconciliation).toMatchObject({
      status: 'SUCCEEDED',
      resourceType: 'StoreReconciliation',
      breakdown: { ordersScanned: 1, orders: 1, inventoryLevels: 1 },
    });

    const orderAfterReconciliation = await readRepository.getOrder(store.id, orders.items[0]!.id);
    expect(orderAfterReconciliation?.currentTotalAmount).toBe('49.99');
    const inventoryAfterReconciliation = await readRepository.listInventory(store.id, {
      page: 1,
      limit: 50,
    });
    expect(inventoryAfterReconciliation.items[0]?.available).toBe(2);
    const periodicSnapshot = await prisma.inventorySnapshot.findFirst({
      where: {
        inventoryItem: { storeId: store.id },
        source: 'PERIODIC_RECONCILIATION',
      },
      orderBy: { createdAt: 'desc' },
    });
    expect(periodicSnapshot?.available).toBe(2);

    const productDeleteBody = Buffer.from(
      JSON.stringify({ id: 9200, admin_graphql_api_id: ids.product }),
      'utf8',
    );
    await service.receiveWebhook(
      {
        hmac: webhookSignature(productDeleteBody),
        topic: 'products/delete',
        shopDomain: store.myshopifyDomain,
        webhookId: 'product-delete-delivery-1',
        apiVersion: '2026-07',
      },
      productDeleteBody,
    );
    expect(await service.processWebhookQueue()).toEqual({ claimed: 1, processed: 1 });

    const currentProducts = await readRepository.listProducts(store.id, { page: 1, limit: 50 });
    expect(currentProducts.total).toBe(0);
    const deletedProduct = await prisma.product.findUnique({
      where: { storeId_shopifyProductId: { storeId: store.id, shopifyProductId: ids.product } },
      select: { deletedAt: true, variants: { select: { deletedAt: true } } },
    });
    expect(deletedProduct?.deletedAt).toBeInstanceOf(Date);
    expect(deletedProduct?.variants[0]?.deletedAt).toBeInstanceOf(Date);

    const status = await readRepository.getStatus(store.id);
    expect(status).toMatchObject({
      connection: { status: 'ACTIVE' },
      counts: { products: 0, orders: 1, locations: 1 },
      orderHistory: { status: 'SUCCEEDED' },
      reconciliation: { status: 'SUCCEEDED' },
    });

    const deliveries = await prisma.webhookDelivery.findMany({
      where: { shopifyConnectionId: store.shopifyConnection!.id },
      select: { externalDeliveryId: true, status: true, attempts: true },
      orderBy: { receivedAt: 'asc' },
    });
    expect(deliveries).toEqual([
      { externalDeliveryId: 'inventory-delivery-1', status: 'PROCESSED', attempts: 1 },
      { externalDeliveryId: 'product-delete-delivery-1', status: 'PROCESSED', attempts: 1 },
    ]);

    const updatedOrdersRequest = fetchMock.mock.calls.find((call) => {
      const requestBody = JSON.parse(
        String((call[1] as RequestInit | undefined)?.body ?? '{}'),
      ) as { query?: string };
      return requestBody.query?.includes('UpdatedOrders');
    });
    const updatedBody = JSON.parse(
      String((updatedOrdersRequest?.[1] as RequestInit).body),
    ) as { variables: { query: string } };
    expect(updatedBody.variables.query).toContain("updated_at:>'");
  });
});
