import { AppError } from '../../errors/app-error.js';
import { memoizeRequestRead } from '../../lib/request-read-cache.js';
import {
  billingService,
  type BillingService,
  type V1AdProvider,
} from '../billing/billing.service.js';
import type { UnifiedAdvertisingProviderFilter } from './unified-advertising.schema.js';
import {
  UnifiedAdvertisingRepository,
  type UnifiedAdvertisingAccountRow,
  type UnifiedProviderConnectionState,
} from './unified-advertising.repository.js';

export interface UnifiedAdvertisingScope {
  states: UnifiedProviderConnectionState[];
  allSelectedAccounts: UnifiedAdvertisingAccountRow[];
  accounts: UnifiedAdvertisingAccountRow[];
}

function connectedProviders(states: UnifiedProviderConnectionState[]): V1AdProvider[] {
  return states
    .filter((state) => state.status === 'ACTIVE' || state.status === 'REAUTH_REQUIRED')
    .map((state) => state.provider);
}

export class UnifiedAdvertisingScopeService {
  constructor(
    private readonly repository: UnifiedAdvertisingRepository = new UnifiedAdvertisingRepository(),
    private readonly billing: BillingService = billingService,
  ) {}

  private async allowedProviders(input: {
    storeId: string;
    states: UnifiedProviderConnectionState[];
    requestedAccount?: UnifiedAdvertisingAccountRow;
    provider: UnifiedAdvertisingProviderFilter;
  }) {
    const plan = await memoizeRequestRead(`unified-advertising:billing:${input.storeId}`, () =>
      this.billing.requireActive(input.storeId),
    );
    if (plan.entitlements.maxAdChannels === null) {
      return new Set<V1AdProvider>(['META', 'TIKTOK', 'GOOGLE_ADS']);
    }

    if (input.requestedAccount) {
      await this.billing.requireAdProviderReadOnly(
        input.storeId,
        input.requestedAccount.provider,
      );
      return new Set<V1AdProvider>([input.requestedAccount.provider]);
    }

    if (input.provider !== 'ALL') {
      await this.billing.requireAdProviderReadOnly(input.storeId, input.provider);
      return new Set<V1AdProvider>([input.provider]);
    }

    const selected = plan.essentialsAdProvider as V1AdProvider | null;
    if (selected) return new Set<V1AdProvider>([selected]);

    const connected = connectedProviders(input.states);
    if (connected.length > 1) {
      // Delegate to the billing boundary so clients receive the canonical selection-required
      // contract (including plan metadata/portal details) instead of duplicating it here.
      await this.billing.requireAdProviderReadOnly(input.storeId, connected[0]!);
    }
    return new Set<V1AdProvider>(connected.length === 1 ? connected : []);
  }

  async resolve(input: {
    storeId: string;
    provider?: UnifiedAdvertisingProviderFilter;
    accountId?: string;
    currency?: string;
  }): Promise<UnifiedAdvertisingScope> {
    const rawStates = await memoizeRequestRead(
      `unified-advertising:connections:${input.storeId}`,
      () => this.repository.connectionStates(input.storeId),
    );
    const rawSelectedAccounts = await memoizeRequestRead(
      `unified-advertising:selected-accounts:${input.storeId}`,
      () => this.repository.selectedAccounts(input.storeId, rawStates),
    );
    const requested = input.accountId
      ? rawSelectedAccounts.find((account) => account.id === input.accountId)
      : undefined;
    if (input.accountId && !requested) {
      throw new AppError(
        'Advertising account is not selected for this store',
        400,
        'ADVERTISING_ACCOUNT_NOT_SELECTED',
      );
    }
    const provider = input.provider ?? 'ALL';
    if (requested && provider !== 'ALL' && requested.provider !== provider) {
      throw new AppError(
        'Advertising account does not belong to the requested provider',
        400,
        'ADVERTISING_ACCOUNT_PROVIDER_MISMATCH',
      );
    }

    const allowedProviders = await this.allowedProviders({
      storeId: input.storeId,
      states: rawStates,
      requestedAccount: requested,
      provider,
    });
    const states = rawStates.filter((state) => allowedProviders.has(state.provider));
    const allSelectedAccounts = rawSelectedAccounts.filter((account) =>
      allowedProviders.has(account.provider),
    );
    let accounts = allSelectedAccounts.filter(
      (account) => provider === 'ALL' || account.provider === provider,
    );
    if (requested) accounts = accounts.filter((account) => account.id === requested.id);
    if (input.currency) {
      accounts = accounts.filter((account) => account.currency === input.currency);
    }
    return { states, allSelectedAccounts, accounts };
  }
}

export const unifiedAdvertisingScopeService = new UnifiedAdvertisingScopeService();
