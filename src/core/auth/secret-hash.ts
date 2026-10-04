import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 32;

/**
 * Stored as "scrypt$<salt>$<hash>". scrypt is deliberately slow and memory-hard, so a leaked
 * table cannot be brute-forced cheaply. The random salt makes equal secrets hash differently.
 */
export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(secret, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

export async function verifySecret(secret: string, stored: string): Promise<boolean> {
  const [algorithm, salt, expected] = stored.split('$');
  if (algorithm !== 'scrypt' || !salt || !expected) return false;
  const actual = await scryptAsync(secret, Buffer.from(salt, 'base64url'), KEY_LENGTH);
  const expectedBuffer = Buffer.from(expected, 'base64url');
  // Constant-time comparison: `===` stops at the first different byte, leaking timing information.
  return actual.length === expectedBuffer.length && timingSafeEqual(actual, expectedBuffer);
}
