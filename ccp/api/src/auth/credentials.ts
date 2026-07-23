import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';
import { pbkdf2Sync, timingSafeEqual } from 'node:crypto';

/**
 * Credential handling. argon2id is authoritative; pbkdf2 exists ONLY to
 * verify v1 imports, which are transparently re-hashed to argon2id on first
 * successful login.
 */

export const MIN_PASSWORD = 8;

/** OWASP baseline (admin-backend.md:175): memoryCost 19456 KiB, timeCost 2, parallelism 1. */
const ARGON2 = {
  algorithm: Algorithm.Argon2id,
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  return argon2Hash(password, ARGON2);
}

/** Constant-time verify (built into argon2). Malformed hash → false, never throws. */
export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2Verify(hash, password);
  } catch {
    return false;
  }
}

export type PbkdfCredential = { hash: string; salt?: string; iterations?: number };

/**
 * v1-import compat. Byte-identical to `ccp/app/src/lib/accounts.ts`:
 * PBKDF2-SHA256, 256-bit derived key, salt+hash base64, constant-time compare.
 */
export function verifyPbkdf2(cred: PbkdfCredential, password: string): boolean {
  if (!cred.salt || !cred.iterations) return false;
  try {
    const salt = Buffer.from(cred.salt, 'base64');
    const derived = pbkdf2Sync(Buffer.from(password, 'utf8'), salt, cred.iterations, 32, 'sha256');
    const expected = Buffer.from(cred.hash, 'base64');
    if (expected.length !== derived.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
