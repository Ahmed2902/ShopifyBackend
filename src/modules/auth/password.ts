import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const FORMAT = 'scrypt$v1';

function deriveKey(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, (error, derivedKey) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(derivedKey);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('base64url');
  const derivedKey = await deriveKey(password, salt);
  return `${FORMAT}$${salt}$${derivedKey.toString('base64url')}`;
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, version, salt, expected] = encoded.split('$');
  if (algorithm !== 'scrypt' || version !== 'v1' || !salt || !expected) return false;

  const expectedBuffer = Buffer.from(expected, 'base64url');
  const actualBuffer = await deriveKey(password, salt);
  if (actualBuffer.length !== expectedBuffer.length) return false;

  return timingSafeEqual(actualBuffer, expectedBuffer);
}
