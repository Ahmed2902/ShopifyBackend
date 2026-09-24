import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { InFlightCoalescer } from '../../lib/in-flight-coalescer.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import {
  shopifyAppPricingClient,
  type ShopifyAppPricingClient,
  type ShopifyAppPricingSubscription,
} from './shopify-app-pricing.client.js';

export const V1_TRIAL_DAYS = 14;

export type V1BillingPlan = 'ESSENTIALS' | 'PRO';
export type V1Entitlement = 'MULTI_AD_CHANNEL' | 'VISITOR_JOURNEYS' | 'ADVANCED_ATTRIBUTION';
export type V1AdProvider = 'META' | 'TIKTOK' | 'GOOGLE_ADS';

const planCatalog = {
  ESSENTIALS: {
    code: 'ESSENTIALS' as const,
    name: 'Essentials',
    monthlyUsd: 49,
    maxAdChannels: 1,
    recommendationLimit: 10,
    sessionExplorer: true,
    visitorJourneys: false,
    advancedAttribution: false,
  },
  PRO: {
    code: 'PRO' as const,
    name: 'Pro',
    monthlyUsd: 99,
    maxAdChannels: null,
    recommendationLimit: 50,
    sessionExplorer: true,
    visitorJourneys: true,
    advancedAttribution: true,
  },
} as const;

function internalTrialEnd(startedAt: Date) {
  return new Date(startedAt.getTime() + V1_TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

function isConnected(status: string | null | undefined) {
  return status === 'ACTIVE' || status === 'REAUTH_REQUIRED';
}

function dateOrNull(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export class BillingService {
  private readonly verificationReads = new InFlightCoalescer(250);

  constructor(private readonly appPricing: ShopifyAppPricingClient = shopifyAppPricingClient) {}

  async ensureSubscription(storeId: string, now = new Date()) {
    let subscription = await prisma.storeSubscription.findUnique({ where: { storeId } });
    if (!subscription) {
      const appPricingEnabled = this.appPricing.isEnabled();
      subscription = await prisma.storeSubscription.create({
        data: appPricingEnabled
          ? {
              storeId,
              selectedPlan: 'ESSENTIALS',
              status: 'EXPIRED',
              provider: 'SHOPIFY',
              trialStartedAt: now,
              trialEndsAt: now,
            }
          : {
              storeId,
              selectedPlan: 'ESSENTIALS',
              status: 'TRIALING',
              provider: 'INTERNAL',
              trialStartedAt: now,
              trialEndsAt: internalTrialEnd(now),
            },
      });
    }

    if (
      !this.appPricing.isEnabled() &&
      subscription.provider === 'INTERNAL' &&
      subscription.status === 'TRIALING' &&
      subscription.trialEndsAt <= now
    ) {
      subscription = await prisma.storeSubscription.update({
        where: { storeId },
        data: { status: 'EXPIRED' },
      });
    }
    return subscription;
  }

  async readLocal(storeId: string, now = new Date()) {
    const subscription = await this.ensureSubscription(storeId, now);
    return this.presentSubscription(
      subscription,
      now,
      this.appPricing.isEnabled() && this.verificationIsStale(subscription, now),
    );
  }

  async read(
    storeId: string,
    now = new Date(),
    options: { fresh?: boolean; failOnVerificationError?: boolean } = {},
  ) {
    let subscription = await this.ensureSubscription(storeId, now);
    let verificationStale = false;

    if (this.appPricing.isEnabled()) {
      const shouldVerify = options.fresh === true || this.verificationIsStale(subscription, now);

      if (shouldVerify) {
        try {
          subscription = await this.verifyShopifySubscription(
            storeId,
            now,
            options.fresh === true,
          );
        } catch (error) {
          if (options.failOnVerificationError || !subscription.lastVerifiedAt) throw error;
          verificationStale = true;
          logger.warn(
            {
              storeId,
              lastVerifiedAt: subscription.lastVerifiedAt,
              error: error instanceof Error ? error.message : String(error),
            },
            'Shopify billing verification failed; using last verified subscription state',
          );
        }
      }
    }

    return this.presentSubscription(subscription, now, verificationStale);
  }

  async portal(storeId: string) {
    if (!this.appPricing.isEnabled()) {
      return {
        mode: 'INTERNAL_TRIAL' as const,
        url: null,
        message: 'Shopify App Pricing is not enabled yet. This store is using the pre-launch internal trial.',
      };
    }

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { myshopifyDomain: true },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    return {
      mode: 'SHOPIFY_APP_PRICING' as const,
      url: this.appPricing.planSelectionUrl(store.myshopifyDomain),
      message: 'Plan selection and payment are managed securely by Shopify.',
    };
  }

  async refreshFromShopify(storeId: string) {
    if (!this.appPricing.isEnabled()) return this.read(storeId);
    return this.read(storeId, new Date(), { fresh: true, failOnVerificationError: true });
  }

  async selectPlan(storeId: string, selectedPlan: V1BillingPlan) {
    await this.ensureSubscription(storeId);
    if (this.appPricing.isEnabled()) {
      const portal = await this.portal(storeId);
      throw new AppError(
        'Plan changes are managed on Shopify’s hosted pricing page.',
        409,
        'SHOPIFY_PRICING_MANAGED',
        { plan: selectedPlan, planSelectionUrl: portal.url },
      );
    }

    await prisma.storeSubscription.update({ where: { storeId }, data: { selectedPlan } });
    return this.read(storeId);
  }

  async selectEssentialsAdProvider(storeId: string, provider: V1AdProvider) {
    const billing = await this.requireActive(storeId);
    if (billing.effectivePlan !== 'ESSENTIALS') {
      throw new AppError(
        'A single-channel selection is only required on Essentials.',
        409,
        'PLAN_CHANNEL_SELECTION_NOT_REQUIRED',
      );
    }

    const connections = await this.connectedProviders(storeId);
    if (!connections.includes(provider)) {
      throw new AppError(
        'Choose an advertising channel that is already connected to this store.',
        400,
        'PLAN_CHANNEL_NOT_CONNECTED',
        { provider, connectedProviders: connections },
      );
    }

    await prisma.storeSubscription.update({
      where: { storeId },
      data: { essentialsAdProvider: provider },
    });
    return this.read(storeId);
  }

  async confirmAdProvider(storeId: string, provider: V1AdProvider) {
    const billing = await this.requireActive(storeId);
    if (billing.entitlements.maxAdChannels === null) return billing;

    const current = await prisma.storeSubscription.findUnique({ where: { storeId } });
    if (!current) throw new AppError('Subscription not found', 404, 'SUBSCRIPTION_NOT_FOUND');
    if (current.essentialsAdProvider && current.essentialsAdProvider !== provider) {
      throw await this.adChannelLimitError(storeId, provider, [current.essentialsAdProvider, provider]);
    }
    if (!current.essentialsAdProvider) {
      await prisma.storeSubscription.update({
        where: { storeId },
        data: { essentialsAdProvider: provider },
      });
    }
    return this.read(storeId);
  }

  async requireActive(storeId: string) {
    const now = new Date();
    let billing = await this.readLocal(storeId, now);

    if (this.appPricing.isEnabled()) {
      const hasNeverVerified = !billing.verification.lastVerifiedAt;
      const inactiveNeedsRefresh = !billing.accessActive && billing.verification.stale;

      if (hasNeverVerified || inactiveNeedsRefresh) {
        billing = await this.read(storeId, now, {
          fresh: true,
          failOnVerificationError: true,
        });
      }
    }

    if (!billing.accessActive) {
      const portal = await this.portal(storeId);
      throw new AppError(
        'Your Stride trial or subscription is not active. Choose a plan to continue using paid features.',
        402,
        'SUBSCRIPTION_REQUIRED',
        {
          selectedPlan: billing.selectedPlan,
          trialEndsAt: billing.trial.endsAt,
          planSelectionUrl: portal.url,
        },
      );
    }
    return billing;
  }

  async requireEntitlement(storeId: string, entitlement: V1Entitlement) {
    const billing = await this.requireActive(storeId);
    const allowed =
      entitlement === 'MULTI_AD_CHANNEL'
        ? billing.entitlements.maxAdChannels === null || billing.entitlements.maxAdChannels > 1
        : entitlement === 'VISITOR_JOURNEYS'
          ? billing.entitlements.visitorJourneys
          : billing.entitlements.advancedAttribution;
    if (!allowed) {
      const portal = await this.portal(storeId);
      throw new AppError(
        'This feature requires the Pro plan.',
        403,
        'PLAN_UPGRADE_REQUIRED',
        {
          entitlement,
          currentPlan: billing.effectivePlan,
          requiredPlan: 'PRO',
          planSelectionUrl: portal.url,
        },
      );
    }
    return billing;
  }

  async requireAdProvider(storeId: string, provider: V1AdProvider) {
    const billing = await this.requireActive(storeId);
    if (billing.entitlements.maxAdChannels === null) return billing;

    const connections = await this.connectedProviders(storeId);
    let selected = billing.essentialsAdProvider as V1AdProvider | null;

    if (!selected && connections.length === 1) {
      selected = connections[0]!;
      await prisma.storeSubscription.update({
        where: { storeId },
        data: { essentialsAdProvider: selected },
      });
    }

    if (!selected && connections.length > 1) {
      const portal = await this.portal(storeId);
      throw new AppError(
        'Essentials includes one advertising channel. Choose which connected channel should remain active in Stride.',
        409,
        'PLAN_CHANNEL_SELECTION_REQUIRED',
        { connectedProviders: connections, planSelectionUrl: portal.url },
      );
    }

    if (selected && selected !== provider) {
      throw await this.adChannelLimitError(storeId, provider, connections);
    }

    if (!selected && connections.length === 1 && connections[0] !== provider) {
      throw await this.adChannelLimitError(storeId, provider, connections);
    }

    return billing;
  }

  async requireAdProviderReadOnly(storeId: string, provider: V1AdProvider) {
    const billing = await this.requireActive(storeId);
    if (billing.entitlements.maxAdChannels === null) return billing;

    const connections = await this.connectedProviders(storeId);
    const selected = billing.essentialsAdProvider as V1AdProvider | null;

    if (!selected && connections.length > 1) {
      const portal = await this.portal(storeId);
      throw new AppError(
        'Essentials includes one advertising channel. Choose which connected channel should remain active in Stride.',
        409,
        'PLAN_CHANNEL_SELECTION_REQUIRED',
        { connectedProviders: connections, planSelectionUrl: portal.url },
      );
    }

    if (selected && selected !== provider) {
      throw await this.adChannelLimitError(storeId, provider, connections);
    }

    if (!selected && connections.length === 1 && connections[0] !== provider) {
      throw await this.adChannelLimitError(storeId, provider, connections);
    }

    return billing;
  }

  private verificationIsStale(
    subscription: Awaited<ReturnType<BillingService['ensureSubscription']>>,
    now: Date,
  ) {
    return (
      !subscription.lastVerifiedAt ||
      now.getTime() - subscription.lastVerifiedAt.getTime() >=
        env.SHOPIFY_BILLING_VERIFY_TTL_SECONDS * 1000
    );
  }

  private presentSubscription(
    subscription: Awaited<ReturnType<BillingService['ensureSubscription']>>,
    now: Date,
    verificationStale: boolean,
  ) {
    const internalTrialActive =
      subscription.provider === 'INTERNAL' &&
      subscription.status === 'TRIALING' &&
      subscription.trialEndsAt > now;
    const shopifyTrialActive =
      subscription.provider === 'SHOPIFY' &&
      subscription.status === 'ACTIVE' &&
      subscription.trialEndsAt > now;
    const trialActive = internalTrialActive || shopifyTrialActive;
    const paidActive = subscription.status === 'ACTIVE';
    const effectivePlan: V1BillingPlan = trialActive ? 'PRO' : subscription.selectedPlan;
    const plan = planCatalog[effectivePlan];

    return {
      status: subscription.status,
      provider: subscription.provider,
      selectedPlan: subscription.selectedPlan,
      effectivePlan,
      essentialsAdProvider: subscription.essentialsAdProvider,
      trial: {
        active: trialActive,
        startedAt: subscription.trialStartedAt,
        endsAt: subscription.trialEndsAt,
        days: V1_TRIAL_DAYS,
      },
      accessActive: trialActive || paidActive,
      currentPeriodEndsAt: subscription.currentPeriodEndsAt,
      cancelAtEndOfCycle: subscription.cancelAtEndOfCycle,
      shopifyPlanHandle: subscription.shopifyPlanHandle,
      plans: Object.values(planCatalog),
      verification: {
        source: this.appPricing.isEnabled() ? 'SHOPIFY_PARTNER_API' : 'INTERNAL',
        lastVerifiedAt: subscription.lastVerifiedAt,
        stale: verificationStale,
      },
      entitlements: {
        maxAdChannels: plan.maxAdChannels,
        recommendationLimit: plan.recommendationLimit,
        sessionExplorer: plan.sessionExplorer,
        visitorJourneys: plan.visitorJourneys,
        advancedAttribution: plan.advancedAttribution,
      },
    };
  }

  private verifyShopifySubscription(storeId: string, now: Date, force: boolean) {
    return this.verificationReads.run(storeId, async () => {
      const current = await this.ensureSubscription(storeId, now);
      if (!force && !this.verificationIsStale(current, now)) return current;
      return this.syncShopifySubscription(storeId, current, now);
    });
  }

  private async connectedProviders(storeId: string): Promise<V1AdProvider[]> {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        metaConnection: { select: { status: true } },
        tiktokConnection: { select: { status: true } },
        googleAdsConnection: { select: { status: true } },
      },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const connected: V1AdProvider[] = [];
    if (isConnected(store.metaConnection?.status)) connected.push('META');
    if (isConnected(store.tiktokConnection?.status)) connected.push('TIKTOK');
    if (isConnected(store.googleAdsConnection?.status)) connected.push('GOOGLE_ADS');
    return connected;
  }

  private async adChannelLimitError(
    storeId: string,
    requestedProvider: V1AdProvider,
    connectedProviders: V1AdProvider[],
  ) {
    const portal = await this.portal(storeId);
    return new AppError(
      'Essentials includes one advertising channel. Choose the existing channel or upgrade to Pro.',
      403,
      'PLAN_AD_CHANNEL_LIMIT',
      {
        currentPlan: 'ESSENTIALS',
        maxAdChannels: 1,
        requestedProvider,
        connectedProviders,
        planSelectionUrl: portal.url,
      },
    );
  }

  private async syncShopifySubscription(
    storeId: string,
    current: Awaited<ReturnType<BillingService['ensureSubscription']>>,
    now: Date,
  ) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { shopifyShopId: true },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const remote = await this.appPricing.activeSubscription(store.shopifyShopId);
    if (!remote) {
      return prisma.storeSubscription.update({
        where: { storeId },
        data: {
          provider: 'SHOPIFY',
          status: current.provider === 'SHOPIFY' && current.status === 'ACTIVE' ? 'CANCELED' : 'EXPIRED',
          currentPeriodEndsAt: null,
          canceledAt:
            current.provider === 'SHOPIFY' && current.status === 'ACTIVE' ? now : current.canceledAt,
          shopifyAppSubscriptionId: null,
          shopifyPlanHandle: null,
          cancelAtEndOfCycle: false,
          lastVerifiedAt: now,
        },
      });
    }

    const selectedPlan = this.planFromRemote(remote);
    const trialEndsAt = dateOrNull(remote.trialEndsAt) ?? now;
    const currentPeriodEndsAt =
      dateOrNull(remote.currentBillingCycle?.endTime) ?? (trialEndsAt > now ? trialEndsAt : null);

    return prisma.storeSubscription.update({
      where: { storeId },
      data: {
        provider: 'SHOPIFY',
        selectedPlan,
        status: 'ACTIVE',
        trialStartedAt:
          current.provider === 'SHOPIFY' && current.lastVerifiedAt ? current.trialStartedAt : now,
        trialEndsAt,
        currentPeriodEndsAt,
        canceledAt: null,
        shopifyAppSubscriptionId: remote.legacySubscriptionId,
        shopifyPlanHandle: this.remotePlanHandle(remote),
        cancelAtEndOfCycle: remote.cancelAtEndOfCycle,
        lastVerifiedAt: now,
      },
    });
  }

  private remotePlanHandle(remote: ShopifyAppPricingSubscription) {
    const handles = this.appPricing.planHandles();
    return remote.items.find(
      (item) => item.handle === handles.ESSENTIALS || item.handle === handles.PRO,
    )?.handle ?? null;
  }

  private planFromRemote(remote: ShopifyAppPricingSubscription): V1BillingPlan {
    const handle = this.remotePlanHandle(remote);
    const handles = this.appPricing.planHandles();
    if (handle === handles.ESSENTIALS) return 'ESSENTIALS';
    if (handle === handles.PRO) return 'PRO';
    throw new AppError(
      'Shopify returned an active Stride subscription with an unrecognized plan handle.',
      503,
      'SHOPIFY_PLAN_UNRECOGNIZED',
      { handles: remote.items.map((item) => item.handle).filter(Boolean) },
    );
  }
}

export const billingService = new BillingService();
