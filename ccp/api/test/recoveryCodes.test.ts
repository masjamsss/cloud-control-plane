import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, type AccountItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { __setNow } from '../src/clock';
import type { ChainEntry } from '../src/domain/audit';
import { findUnusedRecoveryCode, generateRecoveryCodes, hashRecoveryCode, normalizeRecoveryCode, remainingRecoveryCodes } from '../src/auth/recovery';

/**
 * ADR-0025 — one-time recovery codes: auto-issue at first enrolment,
 * self-service regenerate (re-auth-gated), and the recovery-login path
 * (burn one, lockout-coupled failure). See `totpDevices.test.ts` for the
 * "auto-issued at first device" assertions already covered there — this
 * file focuses on the code lifecycle itself: format, burn, regenerate,
 * and the pre-session login door.
 */

const PW = 'correct-horse-battery-staple';
const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' };

async function seedAccount(store: ConfigStore, over: { id: string; role: AccountItem['role'] } & Partial<AccountItem>): Promise<AccountItem> {
  const hash = await hashPassword(PW);
  const item: AccountItem = {
    username: over.id,
    displayName: over.id[0]!.toUpperCase() + over.id.slice(1),
    teamId: 'platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: false,
    credential: { algo: 'argon2id', hash },
    failedAttempts: 0,
    sessionVersion: 1,
    ...over,
    ...accountKey(over.id),
    GSI1PK: accountsGsi(),
    GSI1SK: over.id,
  };
  await store.put(item);
  return item;
}

function post(app: Hono<AppEnv>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { ...CH };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}
function get(app: Hono<AppEnv>, path: string, cookie: string) {
  return app.request(path, { headers: { cookie } });
}
function cookieFrom(res: Response): string {
  const m = /ccp_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `ccp_session=${m[1]}` : '';
}
async function stored(store: ConfigStore, id: string): Promise<AccountItem> {
  return (await store.get(accountKey(id).PK, 'META')) as AccountItem;
}

/** Forced first-login enrolment for a `needsTotp` account — returns the
 * FULL-session cookie and the plaintext recovery codes the enrol response carried. */
async function enrolFirstDevice(app: Hono<AppEnv>, username: string): Promise<{ cookie: string; codes: string[] }> {
  const login = await post(app, '/auth/login', { username, password: PW });
  const { totpEnrollment } = await login.json();
  const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(totpEnrollment.secret) }, cookieFrom(login));
  const body = await enroll.json();
  return { cookie: cookieFrom(enroll), codes: body.recoveryCodes };
}

/* ── generation mechanics (pure) ─────────────────────────────────────────── */

describe('auth/recovery.ts — generation mechanics', () => {
  it('generates exactly 10 codes, each 16 symbols (grouped XXXX-XXXX-XXXX-XXXX = 80 bits)', () => {
    const { plaintext, hashed } = generateRecoveryCodes();
    expect(plaintext).toHaveLength(10);
    expect(hashed).toHaveLength(10);
    for (const code of plaintext) {
      expect(code).toMatch(/^[23-9A-HJ-NP-Z]{4}-[23-9A-HJ-NP-Z]{4}-[23-9A-HJ-NP-Z]{4}-[23-9A-HJ-NP-Z]{4}$/);
      // no ambiguous characters (0/O/1/I)
      expect(code).not.toMatch(/[01OI]/);
    }
  });

  it('every code in a set is unique (10 draws from a 32^16 space — collision is not a real risk, but assert distinctness anyway)', () => {
    const { plaintext } = generateRecoveryCodes();
    expect(new Set(plaintext).size).toBe(10);
  });

  it('normalizeRecoveryCode strips separators/whitespace and uppercases', () => {
    expect(normalizeRecoveryCode('abcd-efgh-jklm-npqr')).toBe('ABCDEFGHJKLMNPQR');
    expect(normalizeRecoveryCode('  ABCD EFGH-JKLM_NPQR  ')).toBe('ABCDEFGHJKLMNPQR');
  });

  it('hashRecoveryCode is stable across formatting variants of the same code', () => {
    const { plaintext, hashed } = generateRecoveryCodes();
    const raw = plaintext[0]!;
    expect(hashRecoveryCode(raw)).toBe(hashed[0]!.hash);
    expect(hashRecoveryCode(raw.toLowerCase())).toBe(hashed[0]!.hash);
    expect(hashRecoveryCode(raw.replace(/-/g, ''))).toBe(hashed[0]!.hash);
    expect(hashRecoveryCode(`  ${raw}  `)).toBe(hashed[0]!.hash);
  });

  it('never stores plaintext — every hashed entry is a 64-char hex digest, distinct from the plaintext', () => {
    const { plaintext, hashed } = generateRecoveryCodes();
    for (let i = 0; i < 10; i++) {
      expect(hashed[i]!.hash).toMatch(/^[a-f0-9]{64}$/);
      expect(hashed[i]!.hash).not.toBe(plaintext[i]);
      expect(hashed[i]!.usedAt).toBeUndefined();
    }
  });

  it('findUnusedRecoveryCode matches the right index and skips already-burned codes even on hash collision-shaped input', () => {
    const { plaintext, hashed } = generateRecoveryCodes();
    const burned = hashed.map((c, i) => (i === 0 ? { ...c, usedAt: '2026-01-01T00:00:00Z' } : c));
    expect(findUnusedRecoveryCode(burned, plaintext[0]!)).toBe(-1); // burned — never matches again
    expect(findUnusedRecoveryCode(burned, plaintext[1]!)).toBe(1);
    expect(findUnusedRecoveryCode(burned, 'not-a-real-code')).toBe(-1);
  });

  it('remainingRecoveryCodes counts only unused codes; undefined set → 0', () => {
    const { hashed } = generateRecoveryCodes();
    expect(remainingRecoveryCodes(hashed)).toBe(10);
    expect(remainingRecoveryCodes(hashed.map((c, i) => (i < 3 ? { ...c, usedAt: 'x' } : c)))).toBe(7);
    expect(remainingRecoveryCodes(undefined)).toBe(0);
  });
});

/* ── GET /auth/recovery-codes ─────────────────────────────────────────────── */

describe('GET /auth/recovery-codes — counts only, ever', () => {
  it('never generated → {remaining: 0}, no generatedAt', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const res = await get(app, '/auth/recovery-codes', cookieFrom(login));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ remaining: 0 });
  });

  it('after first enrolment: remaining is 10 and generatedAt is set — never the codes themselves', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { cookie } = await enrolFirstDevice(app, 'putra');
    const res = await get(app, '/auth/recovery-codes', cookie);
    const body = await res.json();
    expect(body.remaining).toBe(10);
    expect(body.generatedAt).toBeTruthy();
    expect(JSON.stringify(body)).not.toMatch(/[23-9A-HJ-NP-Z]{4}-[23-9A-HJ-NP-Z]{4}/); // no code-shaped strings
  });
});

/* ── POST /auth/recovery-codes/regenerate ─────────────────────────────────── */

describe('POST /auth/recovery-codes/regenerate — replaces the WHOLE set, re-auth-gated', () => {
  it('refused REAUTH_REQUIRED without a fresh elevation', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { cookie } = await enrolFirstDevice(app, 'putra'); // never called /auth/reauth
    const res = await post(app, '/auth/recovery-codes/regenerate', {}, cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REAUTH_REQUIRED');
  });

  it('refused TOTP_REQUIRED when no device is enrolled — codes exist only while 2FA is active', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' }); // no 2FA at all
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    await post(app, '/auth/reauth', { password: PW }, cookie);
    const res = await post(app, '/auth/recovery-codes/regenerate', {}, cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('TOTP_REQUIRED');
  });

  it('replaces the whole set: old codes die (no longer usable), a fresh 10 are returned', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { cookie, codes: oldCodes } = await enrolFirstDevice(app, 'putra');
    await post(app, '/auth/reauth', { password: PW }, cookie);

    const res = await post(app, '/auth/recovery-codes/regenerate', {}, cookie);
    expect(res.status).toBe(200);
    const { codes: newCodes, generatedAt } = await res.json();
    expect(newCodes).toHaveLength(10);
    expect(generatedAt).toBeTruthy();
    expect(new Set(newCodes).size).toBe(10);
    // Byte-different from the old set (fresh random draw).
    expect(newCodes.sort()).not.toEqual([...oldCodes].sort());

    // An OLD code no longer verifies via the login recovery door.
    const relogin = await post(app, '/auth/login', { username: 'putra', password: PW });
    const oldAttempt = await post(app, '/auth/totp/recovery', { code: oldCodes[0] }, cookieFrom(relogin));
    expect(oldAttempt.status).toBe(401);
    // A NEW code does verify.
    const relogin2 = await post(app, '/auth/login', { username: 'putra', password: PW });
    const newAttempt = await post(app, '/auth/totp/recovery', { code: newCodes[0] }, cookieFrom(relogin2));
    expect(newAttempt.status).toBe(200);
  });

  it('is audited as recovery-codes-generate {after:{count:10}} — never the codes/hashes', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true, roles: { '*': { role: 'lead', teamId: 'platform' } } });
    const app = createApp(store);
    const { cookie, codes } = await enrolFirstDevice(app, 'putra');
    await post(app, '/auth/reauth', { password: PW }, cookie);
    await post(app, '/auth/recovery-codes/regenerate', {}, cookie);

    const exp = await (await app.request('/admin/audit/export', { headers: { cookie, 'x-ccp-project': '@control' } })).json();
    const entries = (exp.entries as ChainEntry[]).filter((e) => e.action === 'recovery-codes-generate' && e.actor === 'putra');
    expect(entries).toHaveLength(2); // once at first enrolment, once at this regenerate
    for (const e of entries) {
      expect((e.after as { count: number }).count).toBe(10);
      expect(JSON.stringify(e)).not.toContain(codes[0]);
    }
  });
});

/* ── POST /auth/totp/recovery — the recovery-login door ───────────────────── */

describe('POST /auth/totp/recovery — burns exactly one code, mints a full session', () => {
  it('a valid unused code signs in, burns that one code, and decrements remaining', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { cookie: fullCookie, codes } = await enrolFirstDevice(app, 'putra');
    expect((await (await get(app, '/auth/recovery-codes', fullCookie)).json()).remaining).toBe(10);

    const relogin = await post(app, '/auth/login', { username: 'putra', password: PW });
    expect((await relogin.json()).totpRequired).toBe(true);
    const preCookie = cookieFrom(relogin);
    const recover = await post(app, '/auth/totp/recovery', { code: codes[3] }, preCookie);
    expect(recover.status).toBe(200);
    const body = await recover.json();
    expect(body.recoveryLogin).toBe(true);
    const newFullCookie = cookieFrom(recover);
    expect((await app.request('/auth/me', { headers: { cookie: newFullCookie } })).status).toBe(200);

    expect((await (await get(app, '/auth/recovery-codes', newFullCookie)).json()).remaining).toBe(9);

    // The SAME code is now burned — never usable again.
    const relogin2 = await post(app, '/auth/login', { username: 'putra', password: PW });
    const reuse = await post(app, '/auth/totp/recovery', { code: codes[3] }, cookieFrom(relogin2));
    expect(reuse.status).toBe(401);
  });

  it('accepts a code typed WITHOUT its dashes/with different case (normalized)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { codes } = await enrolFirstDevice(app, 'putra');

    const relogin = await post(app, '/auth/login', { username: 'putra', password: PW });
    const messy = codes[0]!.replace(/-/g, '').toLowerCase();
    const recover = await post(app, '/auth/totp/recovery', { code: messy }, cookieFrom(relogin));
    expect(recover.status).toBe(200);
  });

  it('an unknown/garbage code fails generically (TOTP_REQUIRED — no enumeration) and feeds the SAME lockout counter as a bad password', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    await enrolFirstDevice(app, 'putra');

    // One pre-session, hammered with 5 wrong guesses (a real attacker who
    // already has the password would not re-login between guesses — a fresh
    // correct-password login RESETS failedAttempts, same as it always has).
    const relogin = await post(app, '/auth/login', { username: 'putra', password: PW });
    const preCookie = cookieFrom(relogin);
    for (let i = 0; i < 5; i++) {
      const attempt = await post(app, '/auth/totp/recovery', { code: 'WRONG-WRONG-WRONG-WRON' }, preCookie);
      expect(attempt.status, `attempt ${i + 1}`).toBe(401);
      expect((await attempt.json()).code).toBe('TOTP_REQUIRED');
    }
    // 5 failures locked the ACCOUNT — even a correct password now 429s at login.
    const locked = await post(app, '/auth/login', { username: 'putra', password: PW });
    expect(locked.status).toBe(429);
    expect((await locked.json()).code).toBe('LOGIN_BACKOFF');
  });

  it('a burned code cannot re-authenticate via /auth/reauth (break-glass is login-only, ADR-0025 clause 4)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { cookie } = await enrolFirstDevice(app, 'putra');
    // /auth/reauth's body union only accepts {password} XOR {code:<6-digit TOTP>};
    // a recovery code sent as `code` is checked as a TOTP guess against the
    // enrolled device secret, which it structurally cannot match.
    const res = await post(app, '/auth/reauth', { code: 'ABCD-EFGH-JKLM-NPQR' }, cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('TOTP_REQUIRED');
  });

  it('does NOT clear other devices or codes beyond the one burned', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { cookie, codes } = await enrolFirstDevice(app, 'putra');
    const deviceBefore = (await stored(store, 'putra')).totpDevices;

    const relogin = await post(app, '/auth/login', { username: 'putra', password: PW });
    await post(app, '/auth/totp/recovery', { code: codes[0] }, cookieFrom(relogin));

    const after = await stored(store, 'putra');
    expect(after.totpDevices).toEqual(deviceBefore); // device untouched
    expect(after.recoveryCodes!.codes).toHaveLength(10); // burned, not deleted
    expect(after.recoveryCodes!.codes.filter((c) => c.usedAt).length).toBe(1);
    void cookie;
  });

  it('refuses when there is no pending TOTP pre-session at all', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const { cookie, codes } = await enrolFirstDevice(app, 'putra'); // this IS a full session
    const res = await post(app, '/auth/totp/recovery', { code: codes[0] }, cookie);
    expect(res.status).toBe(401);
  });
});

/* ── admin reset-totp clears codes too (already proven end-to-end in totpDevices.test.ts) ── */

describe('window/clock edge — findUnusedRecoveryCode never resurrects a burned code across time', () => {
  it('burning stays permanent regardless of clock movement', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const T0 = Date.UTC(2026, 6, 11, 9, 0, 0);
    __setNow(() => T0);
    try {
      const { codes } = await enrolFirstDevice(app, 'putra');
      const relogin = await post(app, '/auth/login', { username: 'putra', password: PW });
      await post(app, '/auth/totp/recovery', { code: codes[0] }, cookieFrom(relogin));

      __setNow(() => T0 + 365 * 24 * 60 * 60 * 1000); // a year later
      const relogin2 = await post(app, '/auth/login', { username: 'putra', password: PW });
      const reuse = await post(app, '/auth/totp/recovery', { code: codes[0] }, cookieFrom(relogin2));
      expect(reuse.status).toBe(401);
    } finally {
      __setNow(null);
    }
  });
});
