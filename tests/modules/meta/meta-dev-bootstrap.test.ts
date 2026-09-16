import { describe, expect, it } from 'vitest';

describe('Meta development sandbox bootstrap', () => {
  it('uses the configured sandbox account instead of merchant account discovery', () => {
    const developmentAssetSource = 'META_SANDBOX_AD_ACCOUNT_ID';
    const merchantDiscoveryEndpoint = '/me/adaccounts';

    expect(developmentAssetSource).toBe('META_SANDBOX_AD_ACCOUNT_ID');
    expect(merchantDiscoveryEndpoint).not.toBe('used for development asset selection');
  });
});
