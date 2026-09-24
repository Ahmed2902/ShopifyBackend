import type { AdvertisingProvider } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';

export interface AdvertisingAccountScope {
  id: string;
  providerEntityId: string;
  name: string;
  currency: string | null;
  timezone: string | null;
  status: string | null;
}

/**
 * Resolves canonical paid-media accounts only after intersecting them with the merchant-selected
 * external account ids for the current store/provider. A canonical UUID is never trusted by itself.
 */
export class AdvertisingAccountScopeService {
  async resolve(input: {
    storeId: string;
    provider: AdvertisingProvider;
    selectedAccountExternalIds: string[];
    accountId?: string;
  }): Promise<AdvertisingAccountScope[]> {
    if (input.selectedAccountExternalIds.length === 0) {
      if (input.accountId) {
        throw new AppError(
          'Advertising account is not selected for this store and provider',
          400,
          'ADVERTISING_ACCOUNT_NOT_SELECTED',
        );
      }
      return [];
    }

    const accounts = await prisma.advertisingAccount.findMany({
      where: {
        storeId: input.storeId,
        provider: input.provider,
        providerEntityId: { in: input.selectedAccountExternalIds },
        ...(input.accountId ? { id: input.accountId } : {}),
      },
      select: {
        id: true,
        providerEntityId: true,
        name: true,
        currency: true,
        timezone: true,
        status: true,
      },
      orderBy: [{ name: 'asc' }, { providerEntityId: 'asc' }],
    });

    if (input.accountId && accounts.length === 0) {
      throw new AppError(
        'Advertising account is not selected for this store and provider',
        400,
        'ADVERTISING_ACCOUNT_NOT_SELECTED',
      );
    }
    return accounts;
  }
}

export const advertisingAccountScopeService = new AdvertisingAccountScopeService();
