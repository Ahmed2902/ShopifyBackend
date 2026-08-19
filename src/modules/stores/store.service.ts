import { AppError } from '../../errors/app-error.js';
import type { StoreRepository } from './store.repository.js';
import { withMembershipRole } from './store.utils.js';

export class StoreService {
  constructor(private readonly repository: StoreRepository) {}

  async listForUser(userId: string) {
    const stores = await this.repository.listForUser(userId);
    return stores.map(withMembershipRole);
  }

  async getForUser(userId: string, storeId: string) {
    const membership = await this.requireRole(userId, storeId);
    const store = await this.repository.findById(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return { ...store, role: membership.role };
  }

  async requireRole(userId: string, storeId: string, allowedRoles: string[] = []) {
    const membership = await this.repository.findMembership(userId, storeId);
    if (!membership) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    if (allowedRoles.length > 0 && !allowedRoles.includes(membership.role)) {
      throw new AppError('Insufficient store permissions', 403, 'FORBIDDEN');
    }

    return membership;
  }
}
