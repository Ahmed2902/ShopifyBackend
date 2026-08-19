import { describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../../../src/modules/integrations/integration.utils.js';

describe('integration utilities', () => {
  it('round-trips provider credentials', () => {
    const encrypted = encryptSecret('shpat_secret-token');
    expect(encrypted).not.toContain('shpat_secret-token');
    expect(decryptSecret(encrypted)).toBe('shpat_secret-token');
  });

  it('uses a unique IV per encryption', () => {
    expect(encryptSecret('same-secret')).not.toBe(encryptSecret('same-secret'));
  });

  it('rejects modified ciphertext', () => {
    const encrypted = encryptSecret('secret');
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith('A') ? 'B' : 'A'}`;
    expect(() => decryptSecret(tampered)).toThrow();
  });
});
