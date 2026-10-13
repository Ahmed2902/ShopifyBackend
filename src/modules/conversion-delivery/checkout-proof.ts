import { createHash } from 'node:crypto';

// Retain a store-scoped digest, not a reusable canonical checkout credential.
export function checkoutProofHash(storeId: string, token: string | null | undefined) {
  return token ? createHash('sha256').update(JSON.stringify(['metrico-checkout-v1', storeId, token])).digest('hex') : null;
}
