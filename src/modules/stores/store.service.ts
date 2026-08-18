import { AppError } from '../../errors/app-error.js';
import { storeRepository } from './store.repository.js';
import { withMembershipRole } from './store.utils.js';

export async function listStoresForUser(userId: string) {
  const stores = await storeRepository.listForUser(userId);
  return stores.map(withMembershipRole);
}

export async function getStoreForUser(userId: string, storeId: string) {
  const membership = await requireStoreRole(userId, storeId);
  const store = await storeRepository.findById(storeId);
  if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
  return { ...store, role: membership.role };
}

export async function requireStoreRole(
  userId: string,
  storeId: string,
  allowedRoles: string[] = [],
) {
  const membership = await storeRepository.findMembership(userId, storeId);
  if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

  if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
    throw new AppError('Insufficient store permissions', 403, 'FORBIDDEN');
  }

  return membership;
}
