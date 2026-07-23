import { afterEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, sessionKey, type AccountItem, type SessionItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { sha256hex } from '../src/auth/sessions';
import { __setNow } from '../src/clock';
import type { ChainEntry } from '../src/domain/audit';

/**
 * ADR-0026 — the re-authentication gate: `POST /auth/reauth` (password OR a
 * live TOTP code) stamps `reauthAt` on the CURRENT session item; a 10-minute
 * window; every ⚿ self-service route (device add/remove, recovery-code
 * regenerate, session revoke) refuses `403 REAUTH_REQUIRED` without a fresh
 * one; failures feed the SAME lockout counter as login; a locked account's
 * reauth attempt itself returns `LOGIN_BACKOFF`. The 403→elevate→retry
 * client-side dance is proven at the SPA layer (ReauthDialog); this file
 * proves the SERVER half exhaustively.
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
function del(app: Hono<AppEnv>, path: string, cookie: string) {
  return app.request(path, { method: 'DELETE', headers: { ...CH, cookie } });
}
function cookieFrom(res: Response): string {
  const m = /ccp_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `ccp_session=${m[1]}` : '';
}
async function stored(store: ConfigStore, id: string): Promise<AccountItem> {
  return (await store.get(accountKey(id).PK, 'META')) as AccountItem;
}
function tokenFromCookie(cookie: string): string {
  return /ccp_session=([^;]+)/.exec(cookie)![1]!;
}
async function storedSession(store: ConfigStore, cookie: string): Promise<SessionItem> {
  const k = sessionKey(sha256hex(tokenFromCookie(cookie)));
  return (await store.get(k.PK, k.SK)) as SessionItem;
}

afterEach(() => __setNow(null));

describe('POST /auth/reauth — password branch', () => {
  it('the correct password stamps reauthAt on the CURRENT session and audits reauth-success', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester', roles: { '*': { role: 'requester', teamId: 'platform' } } });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    expect((await storedSession(store, cookie)).reauthAt).toBeUndefined();

    const res = await post(app, '/auth/reauth', { password: PW }, cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true, reauthAt: expect.any(String) });
    expect((await storedSession(store, cookie)).reauthAt).toBe(body.reauthAt);
  });

  it('the wrong password refuses BAD_CREDENTIALS and bumps failedAttempts (audited reauth-failure)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);

    const res = await post(app, '/auth/reauth', { password: 'totally-wrong' }, cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('BAD_CREDENTIALS');
    expect((await stored(store, 'sari')).failedAttempts).toBe(1);
    expect((await storedSession(store, cookie)).reauthAt).toBeUndefined();
  });

  it('a body carrying BOTH password and code (or neither) is rejected VALIDATION_FAILED — exactly one', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);

    const both = await post(app, '/auth/reauth', { password: PW, code: '123456' }, cookie);
    expect(both.status).toBe(422);
    const neither = await post(app, '/auth/reauth', {}, cookie);
    expect(neither.status).toBe(422);
  });

  it('with no session at all → 401 NO_SESSION', async () => {
    const store = new MemoryStore();
    const app = createApp(store);
    const res = await post(app, '/auth/reauth', { password: PW });
    expect(res.status).toBe(401);
  });
});

describe('POST /auth/reauth — TOTP branch (any enrolled device)', () => {
  async function enrolledSetup(): Promise<{ app: Hono<AppEnv>; store: ConfigStore; cookie: string; secret: string }> {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'putra', password: PW });
    const { totpEnrollment } = await login.json();
    const secret: string = totpEnrollment.secret;
    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(secret) }, cookieFrom(login));
    return { app, store, cookie: cookieFrom(enroll), secret };
  }

  it('a live code from the enrolled device elevates', async () => {
    const { app, cookie, secret } = await enrolledSetup();
    const res = await post(app, '/auth/reauth', { code: authenticator.generate(secret) }, cookie);
    expect(res.status).toBe(200);
  });

  it('a wrong code refuses TOTP_REQUIRED (never BAD_CREDENTIALS — no cross-branch leakage)', async () => {
    const { app, cookie } = await enrolledSetup();
    const res = await post(app, '/auth/reauth', { code: '000000' }, cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('TOTP_REQUIRED');
  });

  it('a recovery code is NEVER accepted here — break-glass is login-only (ADR-0025 clause 4 / ADR-0026 clause 1)', async () => {
    const { app, cookie } = await enrolledSetup();
    // A recovery code is a different SHAPE (16 chars from a 32-symbol
    // alphabet, no TOTP verify possible against it) — it is simply checked
    // (and fails) as a TOTP code, exactly like any other wrong code.
    const res = await post(app, '/auth/reauth', { code: 'ABCD-EFGH-JKLM-NPQR' }, cookie);
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('TOTP_REQUIRED');
  });
});

describe('the elevation is per-SESSION and 10 minutes (REAUTH_MS)', () => {
  it('exactly-10-minutes-later still counts; a hair past 10 minutes does not', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const T0 = Date.UTC(2026, 6, 11, 9, 0, 0);
    __setNow(() => T0);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    await post(app, '/auth/reauth', { password: PW }, cookie);

    __setNow(() => T0 + 10 * 60_000); // exactly at the boundary — inclusive (<=)
    const begin = await post(app, '/auth/totp-devices', {}, cookie);
    expect(begin.status).toBe(200);

    __setNow(() => T0 + 10 * 60_000 + 1000); // 10m + 1s
    const begin2 = await post(app, '/auth/totp-devices', {}, cookie);
    expect(begin2.status).toBe(403);
    expect((await begin2.json()).code).toBe('REAUTH_REQUIRED');
  });

  it('re-calling /auth/reauth refreshes the window (the SPA elevate-and-retry flow)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const T0 = Date.UTC(2026, 6, 11, 9, 0, 0);
    __setNow(() => T0);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    await post(app, '/auth/reauth', { password: PW }, cookie);

    __setNow(() => T0 + 9 * 60_000); // 9m — still fresh, but about to lapse
    __setNow(() => T0 + 11 * 60_000); // now stale
    const refused = await post(app, '/auth/totp-devices', {}, cookie);
    expect(refused.status).toBe(403);

    // The exact dance the SPA's ReauthDialog automates: elevate, then retry.
    const elevate = await post(app, '/auth/reauth', { password: PW }, cookie);
    expect(elevate.status).toBe(200);
    const retried = await post(app, '/auth/totp-devices', {}, cookie);
    expect(retried.status).toBe(200);
  });

  it('a DIFFERENT session (another sign-in) is NOT elevated by this one\'s reauth — per-session, never global', async () => {
    const store = new MemoryStore();
    const acc = await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const loginA = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookieA = cookieFrom(loginA);
    await post(app, '/auth/reauth', { password: PW }, cookieA);

    // A second, independent sign-in (another device) — never elevated.
    const loginB = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookieB = cookieFrom(loginB);
    expect(cookieB).not.toBe(cookieA);
    const res = await post(app, '/auth/totp-devices', {}, cookieB);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REAUTH_REQUIRED');
    void acc;
  });

  it('an absent reauthAt on a legacy/pre-existing session fails CLOSED (never treated as elevated)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const { mintSession } = await import('../src/auth/sessions');
    const acc = await stored(store, 'sari');
    // A session minted directly (bypassing /auth/reauth entirely) — the
    // additive-optional reauthAt is simply absent, exactly like a session
    // that predates this build.
    const token = await mintSession(store, 'sari', acc.sessionVersion);
    const res = await post(app, '/auth/totp-devices', {}, `ccp_session=${token}`);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REAUTH_REQUIRED');
  });

  it('signing out and back in starts with NO elevation (a fresh session never inherits reauthAt)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login1 = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie1 = cookieFrom(login1);
    await post(app, '/auth/reauth', { password: PW }, cookie1);
    await app.request('/auth/logout', { method: 'POST', headers: { cookie: cookie1 } });

    const login2 = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie2 = cookieFrom(login2);
    const res = await post(app, '/auth/totp-devices', {}, cookie2);
    expect(res.status).toBe(403);
  });
});

describe('reauth failures feed the SAME lockout counter as login; a locked account cannot reauth', () => {
  it('5 wrong-password reauth attempts lock the account; the 6th (even reauth) is 429 LOGIN_BACKOFF', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);

    for (let i = 0; i < 5; i++) {
      const res = await post(app, '/auth/reauth', { password: 'wrong' }, cookie);
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const sixth = await post(app, '/auth/reauth', { password: 'wrong' }, cookie);
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).code).toBe('LOGIN_BACKOFF');

    // Even the CORRECT password is refused while locked (no oracle).
    const correctWhileLocked = await post(app, '/auth/reauth', { password: PW }, cookie);
    expect(correctWhileLocked.status).toBe(429);

    // The login route itself is ALSO locked out now — one shared counter.
    const loginLocked = await post(app, '/auth/login', { username: 'sari', password: PW });
    expect(loginLocked.status).toBe(429);
  });

  it('a successful reauth resets failedAttempts (mirrors login\'s own reset-on-success)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);

    await post(app, '/auth/reauth', { password: 'wrong' }, cookie);
    await post(app, '/auth/reauth', { password: 'wrong' }, cookie);
    expect((await stored(store, 'sari')).failedAttempts).toBe(2);

    const ok = await post(app, '/auth/reauth', { password: PW }, cookie);
    expect(ok.status).toBe(200);
    expect((await stored(store, 'sari')).failedAttempts).toBe(0);
  });

  it('reauth failure/success are audited as reauth-failure / reauth-success, targetType session', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true, roles: { '*': { role: 'lead', teamId: 'platform' } } });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'putra', password: PW });
    const { totpEnrollment } = await login.json();
    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(totpEnrollment.secret) }, cookieFrom(login));
    const cookie = cookieFrom(enroll);

    await post(app, '/auth/reauth', { password: 'wrong' }, cookie);
    await post(app, '/auth/reauth', { password: PW }, cookie);

    const exp = await (await app.request('/admin/audit/export', { headers: { cookie, 'x-ccp-project': '@control' } })).json();
    const entries = (exp.entries as ChainEntry[]).filter((e) => e.actor === 'putra' && e.action.startsWith('reauth-'));
    expect(entries.map((e) => e.action)).toEqual(['reauth-failure', 'reauth-success']);
    for (const e of entries) expect(e.targetType).toBe('session');
  });
});

describe('every ⚿-gated route in the spec requires a fresh reauth (a spot-check across each family)', () => {
  it('device add, device remove, code regenerate, session revoke-one, revoke-others all 403 without it', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'putra', password: PW });
    const { totpEnrollment } = await login.json();
    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(totpEnrollment.secret) }, cookieFrom(login));
    const cookie = cookieFrom(enroll); // never called /auth/reauth from here on

    const deviceId = (await stored(store, 'putra')).totpDevices![0]!.id;
    const checks: Array<Response | Promise<Response>> = [
      post(app, '/auth/totp-devices', {}, cookie),
      post(app, '/auth/totp-devices/confirm', { code: '000000', name: 'x' }, cookie),
      del(app, `/auth/totp-devices/${deviceId}`, cookie),
      post(app, '/auth/recovery-codes/regenerate', {}, cookie),
      del(app, '/auth/sessions/whatever', cookie),
      post(app, '/auth/sessions/revoke-others', {}, cookie),
    ];
    for (const p of checks) {
      const res = await p;
      expect(res.status, res.url).toBe(403);
      expect((await res.json()).code, res.url).toBe('REAUTH_REQUIRED');
    }
  });

  it('the READ routes (GET totp-devices/recovery-codes/sessions) need NO re-auth at all', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'putra', password: PW });
    const { totpEnrollment } = await login.json();
    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(totpEnrollment.secret) }, cookieFrom(login));
    const cookie = cookieFrom(enroll);

    for (const path of ['/auth/totp-devices', '/auth/recovery-codes', '/auth/sessions']) {
      const res = await app.request(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
    }
  });
});

describe('/auth/change-password is NOT double-gated by reauth (ADR-0026 clause 3)', () => {
  it('the current-password field IS the re-authentication — works with zero prior /auth/reauth calls', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    const res = await post(app, '/auth/change-password', { currentPassword: PW, newPassword: 'a-brand-new-pw-1' }, cookie);
    expect(res.status).toBe(200);
  });
});
