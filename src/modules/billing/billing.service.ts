import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/app-error.js';

export const V1_TRIAL_DAYS = 14;

export type V1BillingPlan = 'ESSENTIALS' | 'PRO';
export type V1Entitlement = 'MULTI_AD_CHANNEL' | 'DEEP_JOURNEYS' | 'ADVANCED_ATTRIBUTION';
export type V1AdProvider = 'META' | 'TIKTOK';

const planCatalog = {
  ESSENTIALS: {
    code: 'ESSENTIALS' as const,
    name: 'Essentials',
    monthlyUsd: 49,
    maxAdChannels: 1,
    recommendationLimit: 10,
    historyDays: 90,
    deepJourneys: false,
    advancedAttribution: false,
  },
  PRO: {
    code: 'PRO' as const,
    name: 'Pro',
    monthlyUsd: 99,
    maxAdChannels: null,
    recommendationLimit: 50,
    historyDays: 365,
    deepJourneys: true,
    advancedAttribution: true,
  },
} as const;

function trialEnd(startedAt: Date) {
  return new Date(startedAt.getTime() + V1_TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

function isConnected(status: string | null | undefined) {
  return status === 'ACTIVE' || status === 'REAUTH_REQUIRED';
}

export class BillingService {
  async ensureSubscription(storeId: string, now = new Date()) {
    let subscription = await prisma.storeSubscription.findUnique({ where: { storeId } });
    if (!subscription) {
      subscription = await prisma.storeSubscription.create({
        data: {
          storeId,
          selectedPlan: 'ESSENTIALS',
          status: 'TRIALING',
          provider: 'INTERNAL',
          trialStartedAt: now,
          trialEndsAt: trialEnd(now),
        },
      });
    }

    if (subscription.status === 'TRIALING' && subscription.trialEndsAt <= now) {
      subscription = await prisma.storeSubscription.update({
        where: { storeId },
        data: { status: 'EXPIRED' },
      });
    }
    return subscription;
  }

  async read(storeId: string, now = new Date()) {
    const subscription = await this.ensureSubscription(storeId, now);
    const trialActive = subscription.status === 'TRIALING' && subscription.trialEndsAt > now;
    const paidActive = subscription.status === 'ACTIVE';
    const effectivePlan: V1BillingPlan = trialActive ? 'PRO' : subscription.selectedPlan;
    const plan = planCatalog[effectivePlan];
    return {
      status: subscription.status,
      provider: subscription.provider,
      selectedPlan: subscription.selectedPlan,
      effectivePlan,
      trial: {
        active: trialActive,
        startedAt: subscription.trialStartedAt,
        endsAt: subscription.trialEndsAt,
        days: V1_TRIAL_DAYS,
      },
      accessActive: trialActive || paidActive,
      currentPeriodEndsAt: subscription.currentPeriodEndsAt,
      plans: Object.values(planCatalog),
      entitlements: {
        maxAdChannels: plan.maxAdChannels,
        recommendationLimit: plan.recommendationLimit,
        historyDays: plan.historyDays,
        deepJourneys: plan.deepJourneys,
        advancedAttribution: plan.advancedAttribution,
      },
    };
  }

  async selectPlan(storeId: string, selectedPlan: V1BillingPlan) {
    await this.ensureSubscription(storeId);
    await prisma.storeSubscription.update({ where: { storeId }, data: { selectedPlan } });
    return this.read(storeId);
  }

  async requireActive(storeId: string) {
    const billing = await this.read(storeId);
    if (!billing.accessActive) {
      throw new AppError(
        'Your Stride trial has ended. Choose a plan to continue using paid features.',
        402,
        'SUBSCRIPTION_REQUIRED',
        { selectedPlan: billing.selectedPlan, trialEndsAt: billing.trial.endsAt },
      );
    }
    return billing;
  }

  async requireEntitlement(storeId: string, entitlement: V1Entitlement) {
    const billing = await this.requireActive(storeId);
    const allowed =
      entitlement === 'MULTI_AD_CHANNEL'
        ? billing.entitlements.maxAdChannels === null || billing.entitlements.maxAdChannels > 1
        : entitlement === 'DEEP_JOURNEYS'
          ? billing.entitlements.deepJourneys
          : billing.entitlements.advancedAttribution;
    if (!allowed) {
      throw new AppError(
        'This feature requires the Pro plan.',
        403,
        'PLAN_UPGRADE_REQUIRED',
        { entitlement, currentPlan: billing.effectivePlan, requiredPlan: 'PRO' },
      );
    }
    return billing;
  }

  async requireAdProvider(storeId: string, provider: V1AdProvider) {
    const billing = await this.requireActive(storeId);
    if (billing.entitlements.maxAdChannels === null) return billing;

    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        metaConnection: { select: { status: true } },
        tiktokConnection: { select: { status: true } },
      },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const targetAlreadyConnected = provider === 'META'
      ? isConnected(store.metaConnection?.status)
      : isConnected(store.tiktokConnection?.status);
    if (targetAlreadyConnected) return billing;

    const otherConnected = provider === 'META'
      ? isConnected(store.tiktokConnection?.status)
      : isConnected(store.metaConnection?.status);
    if (otherConnected) {
      throw new AppError(
        'Essentials includes one advertising channel. Disconnect the current channel or upgrade to Pro.',
        403,
        'PLAN_AD_CHANNEL_LIMIT',
        { currentPlan: billing.effectivePlan, maxAdChannels: 1, requestedProvider: provider },
      );
    }
    return billing;
  }
}

export const billingService = new BillingService();
