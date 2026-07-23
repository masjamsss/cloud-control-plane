import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { createHttpApiClient, type HttpApiClient } from '@/lib/httpApi';
import { noCapabilities } from '@/lib/serverInfo';

/**
 * Integration proof for L10: the HTTP client REALLY talks to ccp-api. We boot
 * the actual server (its own package, its own deps + aliases — a cross-package
 * in-process import can't resolve them here) with a MemoryStore, bootstrap the
 * Lead, then drive the full login → TOTP enroll → me lifecycle THROUGH
 * `createHttpApiClient`, asserting the real cookie/session flow works end to end.
 *
 * The session cookie is httpOnly, so in a browser the client relies on
 * `credentials:'include'`. Node's fetch has no cookie jar, so we inject a tiny one
 * that emulates exactly what the browser does — capture Set-Cookie, resend Cookie —
 * proving the cookie minted at login is what authenticates `me`.
 */

const API_DIR = fileURLToPath(new URL('../../../api', import.meta.url));
const TSX = join(API_DIR, 'node_modules', '.bin', 'tsx');
// This proof boots the REAL ccp-api, which needs that package's deps. CI's
// ccp-app job installs only ccp/app deps, so skip cleanly when tsx is
// absent (runs locally + anywhere ccp/api deps are present) rather than
// hard-failing the app suite with a spawn ENOENT.
const apiDepsReady = existsSync(TSX);
// Unique port per test process (server.ts honors $PORT) so repeated/parallel runs
// never collide on a fixed 8787 (EADDRINUSE flake).
const PORT = 20000 + (process.pid % 20000);
const BASE = `http://127.0.0.1:${PORT}`;

// ---- hand-rolled RFC6238 TOTP (matches otplib authenticator defaults: SHA1/6/30s) ----
function base32Decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase().replace(/\s+/g, '')) {
    const idx = A.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

function totp(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1]! & 0xf;
  const bin =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  return String(bin % 1_000_000).padStart(6, '0');
}

// ---- a minimal cookie jar so Node's fetch behaves like a browser for this flow ----
function cookieJarFetch(): typeof fetch {
  let cookie = '';
  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    if (cookie) headers.set('Cookie', cookie);
    const res = await fetch(input, { ...init, headers });
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      if (kv) cookie = kv; // login mints a pre-session; enroll swaps in the full session
    }
    return res;
  };
  return wrapped as typeof fetch;
}

let server: ChildProcessWithoutNullStreams | undefined;
let oneTimePassword = '';

function bootServer(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(TSX, ['src/server.ts'], {
      cwd: API_DIR,
      // CCP_STORE=memory: a throwaway per-test store. Without it the api now
      // defaults to the durable FileStore, whose refuse-bootstrap-over-existing-
      // data guard (B2) would fail this test's BOOTSTRAP=1 boot on the 2nd run.
      env: { ...process.env, CCP_BOOTSTRAP: '1', CCP_STORE: 'memory', PORT: String(PORT) },
    });
    server = child;
    let out = '';
    // 60s (not 30s): tsx has to compile + boot the api, and under the full parallel
    // vitest suite the machine is CPU-saturated, so a cold boot can occasionally exceed
    // 30s — the intermittent "did not start in time" flake this test used to hit.
    const timer = setTimeout(
      () => reject(new Error(`server did not start in time:\n${out}`)),
      60_000,
    );
    child.stdout.on('data', (d: Buffer) => {
      out += d.toString();
      const pw = /one-time password:\s*(\S+)/.exec(out);
      if (pw) oneTimePassword = pw[1]!;
      if (out.includes(`dev on :${PORT}`) && oneTimePassword) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      out += d.toString();
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('exit', (code) => {
      if (!oneTimePassword) {
        clearTimeout(timer);
        reject(new Error(`server exited early (code ${code}):\n${out}`));
      }
    });
  });
}

beforeAll(async () => {
  await bootServer();
}, 75_000);

afterAll(() => {
  server?.kill('SIGKILL');
});

describe.skipIf(!apiDepsReady)(
  'createHttpApiClient ↔ real ccp-api (L10 authoritative bridge)',
  () => {
    it('drives login → TOTP enroll → me through the real cookie/session flow', async () => {
      const client: HttpApiClient = createHttpApiClient(BASE, { fetch: cookieJarFetch() });

      // serverInfo reports per-flow capabilities (0015 §B3). This client carries
      // real calls for audit/teams/users (0014 P1 #4 + B1), the five
      // estate-governance flows (policy, risk, settings, pendingChanges — see
      // httpApiAdmin.test.ts for per-call coverage), and W5/N2's projects
      // registry + trust surface. Every gate-able flow is served.
      expect(await client.serverInfo()).toEqual({
        mode: 'api',
        capabilities: {
          ...noCapabilities(),
          audit: true,
          teams: true,
          users: true,
          policy: true,
          risk: true,
          settings: true,
          pendingChanges: true,
          projects: true,
        },
      });

      // 1) login — the bootstrapped Lead is privileged, so the server returns a
      //    short-lived pre-session cookie and demands a second factor (not yet enrolled).
      const login = await client.login('putra', oneTimePassword);
      expect(login.user.id).toBe('putra');
      expect(login.user.role).toBe('lead');
      expect(login.totpRequired).toBe(true);
      expect(login.totpEnrollment?.secret).toBeTruthy();

      // 2) enroll — completing TOTP swaps the pre-session cookie for a FULL session.
      const enrolled = await client.enrollTotp(totp(login.totpEnrollment!.secret));
      expect(enrolled.user.id).toBe('putra');

      // 3) me — authenticates PURELY via the session cookie the flow established.
      const me = await client.me();
      expect(me).not.toBeNull();
      expect(me!.user.id).toBe('putra');
      expect(me!.user.role).toBe('lead');
      expect(me!.user.totpEnrolled).toBe(true);

      // 3b) THE GO-LIVE REPRO: auth has fully succeeded (password + TOTP), yet the
      //     bootstrap admin is STILL pinned to its one-time password — /auth/me
      //     reports mustChangePassword:true, and the password gate 403s every
      //     non-auth route. changePassword is the only way out. It re-verifies the
      //     current password, clears the flag, and re-mints the session (the jar
      //     captures the new cookie), so the next me() is a clean full session.
      expect(me!.mustChangePassword).toBe(true);
      const NEW_PW = 'brand-new-strong-pw-9';
      const changed = await client.changePassword(oneTimePassword, NEW_PW);
      expect(changed.user.id).toBe('putra');
      expect(changed.mustChangePassword).toBe(false);
      const settled = await client.me();
      expect(settled!.mustChangePassword).toBe(false);

      // 4) logout — the session cookie is revoked server-side, so a subsequent me()
      //    (same cookie jar) now sees no session. Proves the full app-driven
      //    login → session → me → logout lifecycle, not just a one-way mint.
      await client.logout();
      expect(await client.me()).toBeNull();
    }, 20_000);

    it('me() returns null when no session cookie has been established', async () => {
      const fresh: HttpApiClient = createHttpApiClient(BASE, { fetch: cookieJarFetch() });
      expect(await fresh.me()).toBeNull();
    });
  },
);
