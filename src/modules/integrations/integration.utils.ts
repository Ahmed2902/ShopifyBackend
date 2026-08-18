import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { env } from '../../config/env.js';

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
const AAD = Buffer.from('integration-secret:v1');
const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, 'base64');

if (key.length !== 32) {
  throw new Error('TOKEN_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
}

export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
}

export function decryptSecret(envelope: string): string {
  const [version, ivEncoded, tagEncoded, ciphertextEncoded] = envelope.split('.');
  if (version !== VERSION || !ivEncoded || !tagEncoded || !ciphertextEncoded) {
    throw new Error('Unsupported encrypted secret format');
  }

  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(ivEncoded, 'base64url'));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(tagEncoded, 'base64url'));

  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextEncoded, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export function toErrorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 4000);
}
