import { AppError } from '../../errors/app-error.js';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';
import { prisma } from '../../lib/prisma.js';
import { ShopifyRepository } from './shopify.repository.js';
import { ShopifyApiService } from './shared/shopify-api.service.js';
import { ShopifyAuthService } from './shared/shopify-auth.service.js';

const APP_UNINSTALL_MUTATION = `
  mutation DisconnectStride {
    appUninstall {
      app { id }
      userErrors { field message }
    }
  }
`;

type AppUninstallData = {
  appUninstall: {
    app: { id: string } | null;
    userErrors: Array<{ field?: string[] | null; message: string }>;
  };
};

class ShopifyDisconnectRepository {
  findStore(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        myshopifyDomain: true,
        shopifyConnection: {
          select: {
            id: true,
            status: true,
            accessTokenCiphertext: true,
            accessTokenExpiresAt: true,
            refreshTokenCiphertext: true,
            refreshTokenExpiresAt: true,
            scopes: true,
            apiVersion: true,
          },
        },
      },
    });
  }

  async markDisconnected(storeId: string, providerUninstalled: boolean) {
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.shopifyConnection.update({
        where: { storeId },
        data: {
          status: providerUninstalled ? 'UNINSTALLED' : 'DISCONNECTED',
          uninstalledAt: providerUninstalled ? now : null,
          nextReconciliationAt: null,
          reconciliationClaimedAt: null,
        },
      });

      await tx.pixelInstallation.updateMany({
        where: { storeId },
        data: {
          status: 'DISABLED',
          shopifyWebPixelId: null,
          pendingCollectorTokenHash: null,
          pendingCollectorTokenPrefix: null,
          lastError: null,
        },
      });
    });
  }
}

export class ShopifyDisconnectService {
  private readonly repository: ShopifyDisconnectRepository;
  private readonly authService: ShopifyAuthService;
  private readonly apiService: ShopifyApiService;

  constructor(input?: {
    repository?: ShopifyDisconnectRepository;
    authService?: ShopifyAuthService;
    apiService?: ShopifyApiService;
  }) {
    const credentialRepository = new ShopifyRepository();
    this.repository = input?.repository ?? new ShopifyDisconnectRepository();
    this.apiService = input?.apiService ?? new ShopifyApiService(credentialRepository);
    this.authService =
      input?.authService ?? new ShopifyAuthService(credentialRepository, this.apiService);
  }

  async disconnect(storeId: string) {
    const store = await this.repository.findStore(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const connection = store.shopifyConnection;
    if (!connection) {
      throw new AppError('Shopify is not connected for this store', 409, 'SHOPIFY_NOT_CONNECTED');
    }

    if (connection.status === 'UNINSTALLED' || connection.status === 'DISCONNECTED') {
      await this.repository.markDisconnected(storeId, connection.status === 'UNINSTALLED');
      return {
        status: connection.status,
        shop: store.myshopifyDomain,
        providerUninstalled: connection.status === 'UNINSTALLED',
      } as const;
    }

    let providerUninstalled = false;
    try {
      const accessToken = await this.authService.resolveAccessToken(
        store.myshopifyDomain,
        connection,
      );
      const data = await this.apiService.requestAdminGraphql<AppUninstallData>({
        shop: store.myshopifyDomain,
        accessToken,
        apiVersion: connection.apiVersion,
        query: APP_UNINSTALL_MUTATION,
        connectionId: connection.id,
      });

      if (data.appUninstall.userErrors.length > 0) {
        throw new AppError(
          data.appUninstall.userErrors[0]?.message ?? 'Shopify could not uninstall Stride.',
          502,
          'SHOPIFY_UNINSTALL_FAILED',
        );
      }
      providerUninstalled = true;
    } catch (error) {
      // If the stored credential is already invalid, Stride can still stop using the connection
      // locally and let a fresh OAuth installation replace it. We only claim provider uninstall
      // when Shopify actually accepted appUninstall.
      if (!(error instanceof AppError && error.code === 'SHOPIFY_REAUTH_REQUIRED')) throw error;
    }

    await this.repository.markDisconnected(storeId, providerUninstalled);
    await invalidateStoreDecisionCaches(storeId);

    return {
      status: providerUninstalled ? ('UNINSTALLED' as const) : ('DISCONNECTED' as const),
      shop: store.myshopifyDomain,
      providerUninstalled,
    };
  }
}

export const shopifyDisconnectService = new ShopifyDisconnectService();
