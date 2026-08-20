import { AppError } from '../../../errors/app-error.js';
import { paginateShopifyConnection } from '../shopify.utils.js';
import type { ShopifyApiService } from '../shared/shopify-api.service.js';
import {
  WEBHOOK_SUBSCRIPTIONS_QUERY,
  WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
  WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION,
} from './shopify-webhook.queries.js';
import {
  webhookSubscriptionCreateSchema,
  webhookSubscriptionsSchema,
  webhookSubscriptionUpdateSchema,
  type ShopifyWebhookSubscriptionNode,
} from './shopify-webhook.schema.js';
import { shopifyWebhookUri } from './shopify-webhook.utils.js';

interface ManagedTopic {
  topic: string;
  requiredScope?: string;
}

const MANAGED_TOPICS: ManagedTopic[] = [
  { topic: 'APP_UNINSTALLED' },
  { topic: 'BULK_OPERATIONS_FINISH' },
  { topic: 'PRODUCTS_CREATE', requiredScope: 'read_products' },
  { topic: 'PRODUCTS_UPDATE', requiredScope: 'read_products' },
  { topic: 'PRODUCTS_DELETE', requiredScope: 'read_products' },
  { topic: 'INVENTORY_LEVELS_CONNECT', requiredScope: 'read_inventory' },
  { topic: 'INVENTORY_LEVELS_UPDATE', requiredScope: 'read_inventory' },
  { topic: 'INVENTORY_LEVELS_DISCONNECT', requiredScope: 'read_inventory' },
  { topic: 'LOCATIONS_CREATE', requiredScope: 'read_locations' },
  { topic: 'LOCATIONS_UPDATE', requiredScope: 'read_locations' },
  { topic: 'LOCATIONS_DELETE', requiredScope: 'read_locations' },
  { topic: 'LOCATIONS_ACTIVATE', requiredScope: 'read_locations' },
  { topic: 'LOCATIONS_DEACTIVATE', requiredScope: 'read_locations' },
  { topic: 'ORDERS_CREATE', requiredScope: 'read_orders' },
  { topic: 'ORDERS_UPDATED', requiredScope: 'read_orders' },
  { topic: 'ORDERS_DELETE', requiredScope: 'read_orders' },
  { topic: 'REFUNDS_CREATE', requiredScope: 'read_orders' },
];

export class ShopifyWebhookSubscriptionService {
  constructor(private readonly apiService: ShopifyApiService) {}

  async ensure(input: {
    shop: string;
    accessToken: string;
    apiVersion: string;
    connectionId?: string;
    scopes: string[];
  }): Promise<{ created: number; updated: number; unchanged: number }> {
    const uri = shopifyWebhookUri();
    const subscriptions = await this.list(input);
    const topics = MANAGED_TOPICS.filter(
      (entry) => !entry.requiredScope || this.hasScope(input.scopes, entry.requiredScope),
    );
    let created = 0;
    let updated = 0;
    let unchanged = 0;

    for (const entry of topics) {
      const sameTopic = subscriptions.filter((subscription) => subscription.topic === entry.topic);
      if (sameTopic.some((subscription) => subscription.uri === uri)) {
        unchanged += 1;
        continue;
      }

      const existing = sameTopic[0];
      if (existing) {
        await this.update(input, existing.id, uri);
        updated += 1;
      } else {
        await this.create(input, entry.topic, uri);
        created += 1;
      }
    }

    return { created, updated, unchanged };
  }

  private async list(input: {
    shop: string;
    accessToken: string;
    apiVersion: string;
    connectionId?: string;
  }): Promise<ShopifyWebhookSubscriptionNode[]> {
    const subscriptions: ShopifyWebhookSubscriptionNode[] = [];
    const pages = paginateShopifyConnection(async (cursor) => {
      const data = await this.apiService.requestAdminGraphql<unknown>({
        shop: input.shop,
        accessToken: input.accessToken,
        apiVersion: input.apiVersion,
        connectionId: input.connectionId,
        query: WEBHOOK_SUBSCRIPTIONS_QUERY,
        variables: { first: 100, after: cursor },
      });
      const parsed = webhookSubscriptionsSchema.safeParse(data);
      if (!parsed.success) {
        throw new AppError(
          'Shopify webhook subscriptions query returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      return parsed.data.webhookSubscriptions;
    });

    for await (const page of pages) subscriptions.push(...page);
    return subscriptions;
  }

  private async create(
    input: { shop: string; accessToken: string; apiVersion: string; connectionId?: string },
    topic: string,
    uri: string,
  ): Promise<void> {
    const data = await this.apiService.requestAdminGraphql<unknown>({
      shop: input.shop,
      accessToken: input.accessToken,
      apiVersion: input.apiVersion,
      connectionId: input.connectionId,
      query: WEBHOOK_SUBSCRIPTION_CREATE_MUTATION,
      variables: { topic, webhookSubscription: { uri } },
    });
    const parsed = webhookSubscriptionCreateSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        'Shopify webhook subscription create returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    this.assertMutation(parsed.data.webhookSubscriptionCreate, topic);
  }

  private async update(
    input: { shop: string; accessToken: string; apiVersion: string; connectionId?: string },
    id: string,
    uri: string,
  ): Promise<void> {
    const data = await this.apiService.requestAdminGraphql<unknown>({
      shop: input.shop,
      accessToken: input.accessToken,
      apiVersion: input.apiVersion,
      connectionId: input.connectionId,
      query: WEBHOOK_SUBSCRIPTION_UPDATE_MUTATION,
      variables: { id, webhookSubscription: { uri } },
    });
    const parsed = webhookSubscriptionUpdateSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        'Shopify webhook subscription update returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    this.assertMutation(parsed.data.webhookSubscriptionUpdate, id);
  }

  private assertMutation(
    payload: {
      webhookSubscription: ShopifyWebhookSubscriptionNode | null;
      userErrors: Array<{ message: string }>;
    },
    context: string,
  ): void {
    if (payload.userErrors.length > 0) {
      throw new AppError(
        `Shopify rejected webhook subscription ${context}: ${payload.userErrors.map((error) => error.message).join('; ')}`,
        502,
        'SHOPIFY_WEBHOOK_SUBSCRIPTION_FAILED',
      );
    }
    if (!payload.webhookSubscription) {
      throw new AppError(
        `Shopify did not return webhook subscription ${context}`,
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
  }

  private hasScope(scopes: string[], required: string): boolean {
    if (scopes.includes(required)) return true;
    const writeEquivalent = required.replace(/^read_/, 'write_');
    return scopes.includes(writeEquivalent);
  }
}
