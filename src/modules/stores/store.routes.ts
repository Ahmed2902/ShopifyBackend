import { Router } from 'express';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { getAuthUserId, requireAuth } from '../auth/auth.middleware.js';
import { getStoreId, requireStoreRole } from './store-access.middleware.js';

export const storeRouter = Router();

storeRouter.use(requireAuth);

storeRouter.get('/', async (_req, res) => {
  const userId = getAuthUserId(res);
  const stores = await prisma.store.findMany({
    where: { memberships: { some: { userId } } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      name: true,
      myshopifyDomain: true,
      currencyCode: true,
      ianaTimezone: true,
      createdAt: true,
      memberships: {
        where: { userId },
        select: { role: true },
      },
      shopifyConnection: { select: { status: true } },
      metaConnection: { select: { status: true } },
    },
  });

  res.status(200).json({
    stores: stores.map(({ memberships, ...store }) => ({
      ...store,
      role: memberships[0]?.role,
    })),
  });
});

storeRouter.get('/:storeId', requireStoreRole('OWNER', 'ADMIN', 'MEMBER'), async (_req, res) => {
  const store = await prisma.store.findUnique({
    where: { id: getStoreId(res) },
    select: {
      id: true,
      name: true,
      myshopifyDomain: true,
      currencyCode: true,
      ianaTimezone: true,
      primaryDomainHost: true,
      primaryDomainUrl: true,
      enabledPresentmentCurrencies: true,
      createdAt: true,
      updatedAt: true,
      shopifyConnection: { select: { status: true, lastSyncedAt: true } },
      metaConnection: { select: { status: true, lastSyncedAt: true } },
    },
  });

  if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
  res.status(200).json({ store });
});
