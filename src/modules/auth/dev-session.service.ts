import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import type { StoreRoleClaim } from '../../types/auth.js';
import { issueAccessToken } from './auth.utils.js';

type DevelopmentCandidate = {
  id: string;
  memberships: Array<{
    userId: string;
    role: StoreRoleClaim;
    user: { id: string; email: string; name: string | null };
  }>;
};

const candidateSelect = {
  id: true,
  memberships: {
    select: {
      userId: true,
      role: true,
      user: { select: { id: true, email: true, name: true } },
    },
    orderBy: { createdAt: 'asc' as const },
  },
} as const;

function enabled(): boolean {
  return env.NODE_ENV === 'development' && env.DEV_AUTO_SESSION_ENABLED;
}

async function resolveCandidate(): Promise<DevelopmentCandidate> {
  if (env.DEV_AUTO_SESSION_STORE_ID) {
    const store = await prisma.store.findUnique({
      where: { id: env.DEV_AUTO_SESSION_STORE_ID },
      select: candidateSelect,
    });
    if (!store) {
      throw new AppError(
        'DEV_AUTO_SESSION_STORE_ID does not match a local Store.',
        503,
        'DEV_AUTO_SESSION_STORE_NOT_FOUND',
      );
    }
    if (!store.memberships.length) {
      throw new AppError(
        'The development Store has no membership that can own a session.',
        503,
        'DEV_AUTO_SESSION_MEMBERSHIP_REQUIRED',
      );
    }
    return store as DevelopmentCandidate;
  }

  const stores = await prisma.store.findMany({
    where: { memberships: { some: {} } },
    select: candidateSelect,
    orderBy: { createdAt: 'asc' },
    take: 2,
  });

  if (stores.length === 0) {
    throw new AppError(
      'No local Store with a membership exists. Seed or connect a development store first.',
      503,
      'DEV_AUTO_SESSION_STORE_REQUIRED',
    );
  }
  if (stores.length > 1) {
    throw new AppError(
      'Multiple local Stores exist. Set DEV_AUTO_SESSION_STORE_ID to choose which dashboard to open.',
      503,
      'DEV_AUTO_SESSION_STORE_AMBIGUOUS',
    );
  }

  return stores[0] as DevelopmentCandidate;
}

export async function createDevelopmentAutoSession() {
  if (!enabled()) {
    throw new AppError('Development auto session is disabled.', 404, 'NOT_FOUND');
  }

  const store = await resolveCandidate();
  const membership = store.memberships.find((entry) => entry.role === 'OWNER')
    ?? store.memberships.find((entry) => entry.role === 'ADMIN')
    ?? store.memberships[0];

  if (!membership) {
    throw new AppError(
      'The development Store has no membership that can own a session.',
      503,
      'DEV_AUTO_SESSION_MEMBERSHIP_REQUIRED',
    );
  }

  const stores = [{ storeId: store.id, role: membership.role }];
  const accessToken = await issueAccessToken(membership.userId, stores);

  return {
    user: membership.user,
    accessToken,
    storeId: store.id,
  };
}
