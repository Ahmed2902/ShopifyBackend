import { describe, expect, it } from 'vitest';
import { ShopifyBulkService } from '../../../src/modules/shopify/bulk/shopify-bulk.service.js';
import { ShopifyCatalogService } from '../../../src/modules/shopify/catalog/shopify-catalog.service.js';
import { ShopifyController } from '../../../src/modules/shopify/shopify.controller.js';
import { ShopifyInventoryService } from '../../../src/modules/shopify/inventory/shopify-inventory.service.js';
import { ShopifyOrderRepository } from '../../../src/modules/shopify/order/shopify-order.repository.js';
import { ShopifyOrderService } from '../../../src/modules/shopify/order/shopify-order.service.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';
import { ShopifyApiService } from '../../../src/modules/shopify/shared/shopify-api.service.js';
import { ShopifyAuthService } from '../../../src/modules/shopify/shared/shopify-auth.service.js';

describe('Shopify feature layout', () => {
  it('keeps the facade, controller, shared infrastructure and feature services importable', () => {
    expect(ShopifyController).toBeTypeOf('function');
    expect(ShopifyService).toBeTypeOf('function');
    expect(ShopifyApiService).toBeTypeOf('function');
    expect(ShopifyAuthService).toBeTypeOf('function');
    expect(ShopifyBulkService).toBeTypeOf('function');
    expect(ShopifyCatalogService).toBeTypeOf('function');
    expect(ShopifyInventoryService).toBeTypeOf('function');
    expect(ShopifyOrderService).toBeTypeOf('function');
    expect(ShopifyOrderRepository).toBeTypeOf('function');
  });
});
