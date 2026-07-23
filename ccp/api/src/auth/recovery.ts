import { randomBytes, timingSafeEqual } from 'node:crypto';
import { sha256hex } from './sessions';

/**
 * One-time recovery codes (ADR-0025) — break-glass login only when every
 * enrolled TOTP device is lost. Storage precedent: plain sha256 at rest,
 * same class as session tokens (`auth/sessions.ts#sha256hex`) — 80 bits of
 * entropy per code makes offline brute-force of the hash infeasible, so
 * argon2id (built for LOW-entropy secrets like passwords) buys nothing here
 * but latency.
 */

/** 10 codes per set (ADR-0025 clause 1). */
export const RECOVERY_CODE_COUNT = 10;

/** 16 symbols per code from a 32-symbol alphabet = 16 * 5 = 80 bits of entropy. */
export const RECOVERY_CODE_LENGTH = 16;

/**
 * Crockford-style unambiguous alphabet — no `0`/`O`/`1`/`I` (ADR-0025 clause
 * 1). Exactly 32 symbols (2^5), so a raw random BYTE modulo the alphabet
 * length is UNBIASED (256 / 32 = 8 exactly) — no rejection sampling needed.
 */
const ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

function randomRawCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_LENGTH);
  let out = '';
  for (const b of bytes) out += ALPHABET[b % ALPHABET.length];
  return out;
}

/** Display grouping: `XXXX-XXXX-XXXX-XXXX` (ADR-0025 clause 1). */
function formatForDisplay(raw: string): string {
  return (raw.match(/.{1,4}/g) ?? [raw]).join('-');
}

/** Strip separators/whitespace and uppercase — the normalization both
 * generation (implicitly, the alphabet is already uppercase/no-separator)
 * and verification (explicitly, over user-typed input) share. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** sha256hex of the NORMALIZED code — the exact value stored at rest and
 * recomputed at verify time. */
export function hashRecoveryCode(code: string): string {
  return sha256hex(normalizeRecoveryCode(code));
}

/** The exact shape `AccountItem.recoveryCodes.codes` stores — `usedAt` is
 * always absent on a freshly generated entry, but typed optional here (not
 * omitted) so it matches the stored shape byte-for-byte with no cast at the
 * call site (`store.put({..., recoveryCodes: {codes: hashed, ...}})`). */
export type StoredRecoveryCode = { hash: string; usedAt?: string };

export interface GeneratedRecoveryCodes {
  /** Shown to the user EXACTLY ONCE — never stored, never logged. */
  plaintext: string[];
  /** What actually gets persisted on the account (`AccountItem.recoveryCodes.codes`). */
  hashed: StoredRecoveryCode[];
}

/** A fresh set of {@link RECOVERY_CODE_COUNT} codes. Regeneration REPLACES
 * the whole set (ADR-0025 clause 2) — callers never merge with the old set. */
export function generateRecoveryCodes(): GeneratedRecoveryCodes {
  const plaintext: string[] = [];
  const hashed: StoredRecoveryCode[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const raw = randomRawCode();
    plaintext.push(formatForDisplay(raw));
    hashed.push({ hash: hashRecoveryCode(raw) });
  }
  return { plaintext, hashed };
}

/** Constant-time compare of two hex digests — defends the recovery-code
 * verify loop (ADR-0025 clause 1: "compares constant-time against unused
 * hashes"). Equal-length hex from the same hash function; a length mismatch
 * (should never happen — sha256 hex is always 64 chars) fails closed. */
function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/** The index of the first UNUSED code matching `candidate`, or -1. Never
 * short-circuits on a used code's hash matching first (skips it and keeps
 * looking) — a burned code must never be usable again even if its hash
 * happens to be typed twice. */
export function findUnusedRecoveryCode(codes: Array<{ hash: string; usedAt?: string }>, candidate: string): number {
  const hash = hashRecoveryCode(candidate);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i]!;
    if (c.usedAt) continue;
    if (constantTimeEqualHex(c.hash, hash)) return i;
  }
  return -1;
}

/** How many codes in a set are still unused (never round-trips the codes
 * themselves — API/audit responses show counts only, ever). */
export function remainingRecoveryCodes(codes: Array<{ usedAt?: string }> | undefined): number {
  return codes ? codes.filter((c) => !c.usedAt).length : 0;
}
