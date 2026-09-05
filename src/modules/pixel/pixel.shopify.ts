import { z } from 'zod';
import { AppError } from '../../errors/app-error.js';
import { ShopifyRepository } from '../shopify/shopify.repository.js';
import { ShopifyApiService } from '../shopify/shared/shopify-api.service.js';
import { ShopifyAuthService } from '../shopify/shared/shopify-auth.service.js';

const REQUIRED_PIXEL_SCOPES = ['write_pixels', 'read_pixels', 'read_customer_events'] as const;

const webPixelSchema = z.object({
  id: z.string().min(1),
  settings: z.unknown(),
});

const webPixelUserErrorSchema = z.object({
  field: z.array(z.string()).nullable().optional(),
  message: z.string(),
  code: z.string().nullable().optional(),
});

const findResponseSchema = z.object({
  webPixel: webPixelSchema.nullable(),
});

const createResponseSchema = z.object({
  webPixelCreate: z.object({
    userErrors: z.array(webPixelUserErrorSchema),
    webPixel: webPixelSchema.nullable(),
  }),
});

const updateResponseSchema = z.object({
  webPixelUpdate: z.object({
    userErrors: z.array(webPixelUserErrorSchema),
    webPixel: webPixelSchema.nullable(),
  }),
});

const WEB_PIXEL_QUERY = `
query StrideWebPixel {
  webPixel { id settings }
}
`;

const WEB_PIXEL_CREATE_MUTATION = `
mutation StrideWebPixelCreate($webPixel: WebPixelInput!) {
  webPixelCreate(webPixel: $webPixel) {
    userErrors { field message code }
    webPixel { id settings }
  }
}
`;

const WEB_PIXEL_UPDATE_MUTATION = `
mutation StrideWebPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
  webPixelUpdate(id: $id, webPixel: $webPixel) {
    userErrors { field message code }
    webPixel { id settings }
  }
}
`;

function normalizePixelSettings(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export class ShopifyPixelProvisioner {
  private readonly repository: ShopifyRepository;
  private readonly apiService: ShopifyApiService;
  private readonly authService: ShopifyAuthService;

  constructor(
    repository = new ShopifyRepository(),
    apiService?: ShopifyApiService,
    authService?: ShopifyAuthService,
  ) {
    this.repository = repository;
    this.apiService = apiService ?? new ShopifyApiService(repository);
    this.authService = authService ?? new ShopifyAuthService(repository, this.apiService);
  }

  async inspect(storeId: string): Promise<{ id: string; settings: Record<string, unknown> | null } | null> {
    const { context } = await this.resolveContext(storeId);
    const response = await this.apiService.requestAdminGraphql<unknown>({
      ...context,
      query: WEB_PIXEL_QUERY,
    });
    const parsed = findResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new AppError(
        'Shopify web pixel lookup returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    const webPixel = parsed.data.webPixel;
    return webPixel ? { id: webPixel.id, settings: normalizePixelSettings(webPixel.settings) } : null;
  }

  async upsert(input: {
    storeId: string;
    existingWebPixelId: string | null;
    settings: Record<string, string>;
  }): Promise<{ id: string }> {
    const { context } = await this.resolveContext(input.storeId);

    // Treat Shopify as the source of truth for the current WebPixel resource. The locally stored
    // provider ID can become stale if Shopify or the merchant deletes/recreates the pixel; always
    // inspect the live resource before deciding whether to update or create.
    const lookup = await this.apiService.requestAdminGraphql<unknown>({
      ...context,
      query: WEB_PIXEL_QUERY,
    });
    const parsedLookup = findResponseSchema.safeParse(lookup);
    if (!parsedLookup.success) {
      throw new AppError(
        'Shopify web pixel lookup returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    const webPixelId = parsedLookup.data.webPixel?.id ?? null;

    // Shopify's WebPixelInput expects its `settings` JSON scalar as a JSON-formatted string.
    const variables = {
      webPixel: {
        settings: JSON.stringify(input.settings),
      },
    };

    if (webPixelId) {
      const response = await this.apiService.requestAdminGraphql<unknown>({
        ...context,
        query: WEB_PIXEL_UPDATE_MUTATION,
        variables: { id: webPixelId, ...variables },
      });
      const parsed = updateResponseSchema.safeParse(response);
      if (!parsed.success) {
        throw new AppError(
          'Shopify web pixel update returned an unexpected shape',
          502,
          'SHOPIFY_BAD_RESPONSE',
        );
      }
      return this.unwrapResult(parsed.data.webPixelUpdate, 'update');
    }

    const response = await this.apiService.requestAdminGraphql<unknown>({
      ...context,
      query: WEB_PIXEL_CREATE_MUTATION,
      variables,
    });
    const parsed = createResponseSchema.safeParse(response);
    if (!parsed.success) {
      throw new AppError(
        'Shopify web pixel creation returned an unexpected shape',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    return this.unwrapResult(parsed.data.webPixelCreate, 'create');
  }

  private async resolveContext(storeId: string) {
    const target = await this.repository.findConnectionForSync(storeId);
    if (!target) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const connection = target.shopifyConnection;
    if (!connection) {
      throw new AppError('Shopify is not connected for this store', 409, 'SHOPIFY_NOT_CONNECTED');
    }
    if (connection.status !== 'ACTIVE') {
      throw new AppError(
        'Shopify connection requires merchant attention',
        409,
        'SHOPIFY_CONNECTION_INACTIVE',
      );
    }

    const missingScopes = REQUIRED_PIXEL_SCOPES.filter((scope) => !connection.scopes.includes(scope));
    if (missingScopes.length > 0) {
      throw new AppError(
        'Shopify must be reauthorized with customer-event pixel access',
        409,
        'SHOPIFY_PIXEL_SCOPE_REQUIRED',
        { missingScopes },
      );
    }

    const accessToken = await this.authService.resolveAccessToken(
      target.myshopifyDomain,
      connection,
    );
    return {
      context: {
        shop: target.myshopifyDomain,
        accessToken,
        apiVersion: connection.apiVersion,
        connectionId: connection.id,
      },
    };
  }

  private unwrapResult(
    result: {
      userErrors: Array<{ message: string; code?: string | null }>;
      webPixel: { id: string } | null;
    },
    operation: 'create' | 'update',
  ) {
    if (result.userErrors.length > 0) {
      throw new AppError(
        `Shopify could not ${operation} the Stride web pixel`,
        409,
        'SHOPIFY_PIXEL_CONFIGURATION_FAILED',
        {
          errors: result.userErrors.map((error) => ({
            code: error.code ?? null,
            message: error.message,
          })),
        },
      );
    }
    if (!result.webPixel) {
      throw new AppError(
        'Shopify web pixel mutation did not return a web pixel',
        502,
        'SHOPIFY_BAD_RESPONSE',
      );
    }
    return { id: result.webPixel.id };
  }
}
