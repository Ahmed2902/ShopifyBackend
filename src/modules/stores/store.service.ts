import { AppError } from '../../errors/app-error.js';
import type { StoreRepository } from './store.repository.js';
import { withMembershipRole } from './store.utils.js';

export class StoreService {
  constructor(private readonly repository: StoreRepository) {}

  async listForUser(userId: string) {
    const stores = await this.repository.listForUser(userId);
    return stores.map(withMembershipRole);
  }

  async getById(storeId: string) {
    const store = await this.repository.findById(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    return store;
  }
}
