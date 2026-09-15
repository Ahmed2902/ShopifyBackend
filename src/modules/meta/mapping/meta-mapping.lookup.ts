import { AppError } from '../../../errors/app-error.js';
import type { MetaMappingService } from './meta-mapping.service.js';

const LOOKUP_PAGE_SIZE = 100;

/**
 * Read one selected Meta ad through the existing normalized mapping list path.
 *
 * The mapping list already enforces selected-account scope, attaches active
 * collection mappings and normalizes Prisma Decimal confidence values. Reusing
 * it here keeps the single-ad response identical to queue rows instead of
 * introducing a second mapping projection that can drift.
 */
export async function findSelectedMetaAdMapping(
  service: Pick<MetaMappingService, 'listAdMappings'>,
  storeId: string,
  metaAdId: string,
) {
  let page = 1;

  while (true) {
    const result = await service.listAdMappings(storeId, page, LOOKUP_PAGE_SIZE);
    const match = result.items.find((ad) => ad.metaAdId === metaAdId);
    if (match) return match;

    if (page * LOOKUP_PAGE_SIZE >= result.total) break;
    page += 1;
  }

  throw new AppError('Meta ad was not found', 404, 'META_AD_NOT_FOUND');
}
