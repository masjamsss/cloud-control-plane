import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0024 clause 2's contract: every reader of 2FA device state MUST go
 * through the `totpDevicesOf` shim (`src/auth/totp.ts`) — never a raw
 * `AccountItem.totp`/`.totpDevices` member read. This is the grep-based
 * pin the spec calls for (§10 A1: "a test pins raw `\.totp\b`/`totpDevices`
 * account-field reads to the shim's module"), same style as the SPA's
 * source-genericity gate (`ccp/app/scripts/verify-source-genericity.ts`).
 *
 * Scans every `src/**\/*.ts` file EXCEPT the shim module itself. A line is a
 * permitted WRITE (never flagged) when it is a `delete x.totp[Devices]`
 * statement (the lazy-migration cleanup / admin reset-totp full wipe) or an
 * object-literal key `totp:`/`totpDevices:` (a schema declaration or a
 * `{ ...account, totpDevices: next }` materializing write) — this test is
 * about READS, not the writes that materialize/clear the shape.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const SHIM_MODULE = join(SRC, 'auth', 'totp.ts');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return walk(p);
    return name.endsWith('.ts') ? [p] : [];
  });
}

// Permitted write shapes — never flagged even though they touch the fields.
const WRITE_SHAPES = [
  /^\s*delete\s+\S+\.totp(Devices)?\b/, // `delete updated.totp;` / `delete updated.totpDevices;`
  /\btotp(Devices)?\s*:/, // an object-literal key (schema decl or a materializing write)
];

// A raw member-access READ of the legacy `totp` field or the `totpDevices`
// array — excludes `totpDevicesOf` (the shim function itself), `totpRequired`
// (an unrelated admin-pinned field), and `totpEnrolled` (the PublicAccount
// projection field, already derived through the shim).
const RAW_READ = /\.totp(?!DevicesOf|Required|Enrolled)(Devices)?\b/;

describe('ADR-0024 contract — 2FA device state is read ONLY through totpDevicesOf', () => {
  it('scans a real source tree (sanity)', () => {
    expect(walk(SRC).length).toBeGreaterThan(50);
  });

  it('no file outside auth/totp.ts reads AccountItem.totp / .totpDevices directly', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC)) {
      if (file === SHIM_MODULE) continue;
      const rel = relative(SRC, file);
      const text = readFileSync(file, 'utf8');
      text.split('\n').forEach((raw, i) => {
        const code = raw.split('//')[0] ?? ''; // ignore trailing line comments
        if (!RAW_READ.test(code)) return;
        if (WRITE_SHAPES.some((re) => re.test(code))) return;
        offenders.push(`${rel}:${i + 1}: ${raw.trim()}`);
      });
    }
    expect(offenders, offenders.join('\n')).toEqual([]);
  });

  it('the shim module itself is the one place that DOES read the raw fields', () => {
    const text = readFileSync(SHIM_MODULE, 'utf8');
    expect(text).toContain('account.totpDevices');
    expect(text).toContain('account.totp');
  });
});
