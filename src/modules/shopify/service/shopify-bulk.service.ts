import { AppError } from '../../../errors/app-error.js';
import {
  BULK_OPERATION_RUN_QUERY,
  BULK_OPERATION_STATUS_QUERY,
} from '../shopify-bulk.queries.js';
import {
  bulkOperationStartSchema,
  bulkOperationStatusSchema,
} from '../shopify-bulk.schema.js';
import type { ShopifySyncContext } from '../shopify.types.js';
import type { ShopifyApiService } from './shopify-api.service.js';

const BULK_DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export class ShopifyBulkService {
  constructor(private readonly apiService: ShopifyApiService) {}

  async startQuery(input: ShopifySyncContext, query: string) {
    const data = await this.apiService.requestAdminGraphql<unknown>({
      shop: input.shop,
      accessToken: input.accessToken,
      apiVersion: input.apiVersion,
      connectionId: input.connectionId,
      query: BULK_OPERATION_RUN_QUERY,
      variables: { query },
    });
    const parsed = bulkOperationStartSchema.safeParse(data);
    if (!parsed.success) {
      throw new AppError(
        'Shopify bulk-operation response had an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }

    const payload = parsed.data.bulkOperationRunQuery;
    if (payload.userErrors.length > 0) {
      throw new AppError(
        payload.userErrors.map((error) => error.message).join('; '),
        502,
        'SHOPIFY_BULK_REJECTED',
      );
    }
    if (!payload.bulkOperation) {
      throw new AppError(
        'Shopify did not create the bulk operation',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }

    return payload.bulkOperation;
  }

  async getStatus(input: ShopifySyncContext, operationId: string) {
    const data = await this.apiService.requestAdminGraphql<unknown>({
      shop: input.shop,
      accessToken: input.accessToken,
      apiVersion: input.apiVersion,
      connectionId: input.connectionId,
      query: BULK_OPERATION_STATUS_QUERY,
      variables: { id: operationId },
    });
    const parsed = bulkOperationStatusSchema.safeParse(data);
    if (!parsed.success || !parsed.data.bulkOperation) {
      throw new AppError(
        'Shopify bulk operation could not be found',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    if (parsed.data.bulkOperation.id !== operationId) {
      throw new AppError(
        'Shopify returned a different bulk operation',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    return parsed.data.bulkOperation;
  }

  async *streamJsonl(url: string): AsyncGenerator<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Accept: 'application/jsonl, application/x-ndjson, text/plain' },
        signal: AbortSignal.timeout(BULK_DOWNLOAD_TIMEOUT_MS),
      });
    } catch {
      throw new AppError(
        'Could not download Shopify bulk-operation results',
        502,
        'SHOPIFY_BULK_DOWNLOAD_FAILED',
      );
    }

    if (!response.ok || !response.body) {
      throw new AppError(
        'Shopify bulk-operation result download failed',
        502,
        'SHOPIFY_BULK_DOWNLOAD_FAILED',
      );
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (line) yield this.parseJsonlLine(line);
        newlineIndex = buffer.indexOf('\n');
      }

      if (done) break;
    }

    const lastLine = buffer.trim();
    if (lastLine) yield this.parseJsonlLine(lastLine);
  }

  private parseJsonlLine(line: string): unknown {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw new AppError(
        'Shopify bulk-operation result contained invalid JSONL',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
  }
}
