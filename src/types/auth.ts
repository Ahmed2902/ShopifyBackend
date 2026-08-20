export type StoreRoleClaim = 'OWNER' | 'ADMIN' | 'MEMBER';

export interface StoreAccessClaim {
  storeId: string;
  role: StoreRoleClaim;
}
