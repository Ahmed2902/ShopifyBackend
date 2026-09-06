import { describe, expect, it } from 'vitest';
import { requireTikTokAppCredentials, requireTikTokStateSecret } from '../../../src/modules/tiktok/tiktok.config.js';

// tests/setup.ts configures TikTok credentials for the test environment, so this
// suite verifies the positive contract while deployment smoke tests cover the
// optional-at-boot behavior.
describe('TikTok runtime configuration', () => {
  it('returns configured app credentials', () => {
    expect(requireTikTokAppCredentials()).toEqual({
      appId: 'test-tiktok-app-id',
      appSecret: 'test-tiktok-app-secret',
    });
  });

  it('returns the configured OAuth state secret', () => {
    expect(requireTikTokStateSecret()).toBe(
      'test-tiktok-state-secret-that-is-over-thirty-two-characters',
    );
  });
});
