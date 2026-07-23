import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import { FileStore } from '../src/store/fileStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, type AccountItem, type ChainHeadItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import type { ChainEntry } from '../src/domain/audit';

/**
 * ADR-0024 (multi-device TOTP) — the shim + lazy migration, the self-service
 * device routes (§5), the 5-device cap, and the last-factor guard. Recovery
 * codes are covered in `recoveryCodes.test.ts`; the re-auth gate itself
 * (403 → elevate → retry → window expiry → lockout feed) is covered in
 * `reauth.test.ts` — this file only exercises the device routes THROUGH an
 * already-elevated session (reauth is proven to gate them once, in the last
 * describe block, and exhaustively elsewhere).
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

/** Log a seeded account in fully (password + TOTP if needed), returning the
 * FULL-session cookie. `withReauth` also stamps a fresh re-auth elevation
 * (password) so the ⚿ device/session routes are immediately callable. */
async function loginAndElevate(app: Hono<AppEnv>, username: string, password = PW): Promise<string> {
  const login = await post(app, '/auth/login', { username, password });
  let cookie = cookieFrom(login);
  const body = await login.json();
  if (body.totpEnrollment) {
    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(body.totpEnrollment.secret) }, cookie);
    cookie = cookieFrom(enroll);
  } else if (body.totpRequired) {
    throw new Error('loginAndElevate: account already enrolled — use a dedicated flow');
  }
  const reauth = await post(app, '/auth/reauth', { password }, cookie);
  expect(reauth.status, 'reauth for test setup').toBe(200);
  return cookieFrom(reauth) || cookie; // /auth/reauth does not re-mint a cookie, but be defensive
}

/* ── the shim + lazy migration ────────────────────────────────────────────── */

describe('ADR-0024 clause 2 — the totpDevicesOf shim and lazy migration', () => {
  it('a legacy single-secret account is indistinguishable from a one-device account named "Authenticator" at the public projection', async () => {
    const store = new MemoryStore();
    await seedAccount(store, {
      id: 'dewi',
      role: 'lead',
      totp: { secretEnc: 'legacy-enc-secret', enrolledAt: '2026-07-11T00:00:00.000Z' },
    });
    const app = createApp(store);
    // GET /auth/totp-devices reads through the shim.
    const cookie = `ccp_session=${await (async () => {
      const { mintSession } = await import('../src/auth/sessions');
      const acc = await stored(store, 'dewi');
      return mintSession(store, 'dewi', acc.sessionVersion);
    })()}`;
    const res = await get(app, '/auth/totp-devices', cookie);
    expect(res.status).toBe(200);
    const devices = await res.json();
    expect(devices).toEqual([{ id: 'legacy', name: 'Authenticator', enrolledAt: '2026-07-11T00:00:00.000Z' }]);
  });

  it('a legacy account\'s first successful LOGIN verify materializes totpDevices and deletes the legacy field (idempotent — a second login is a no-op re-materialization)', async () => {
    const store = new MemoryStore();
    const secret = authenticator.generateSecret();
    const { getCipher } = await import('../src/auth/totp');
    await seedAccount(store, {
      id: 'dewi',
      role: 'lead',
      totp: { secretEnc: getCipher().enc(secret), enrolledAt: '2026-07-11T00:00:00.000Z' },
    });
    const app = createApp(store);

    const before = await stored(store, 'dewi');
    expect(before.totp).toBeDefined();
    expect(before.totpDevices).toBeUndefined();

    const login1 = await post(app, '/auth/login', { username: 'dewi', password: PW });
    const verify1 = await post(app, '/auth/totp', { code: authenticator.generate(secret) }, cookieFrom(login1));
    expect(verify1.status).toBe(200);

    const afterFirst = await stored(store, 'dewi');
    expect(afterFirst.totp).toBeUndefined(); // legacy field deleted
    expect(afterFirst.totpDevices).toHaveLength(1);
    expect(afterFirst.totpDevices![0]!.id).toBe('legacy');
    expect(afterFirst.totpDevices![0]!.name).toBe('Authenticator');
    expect(afterFirst.totpDevices![0]!.lastUsedAt).toBeDefined();

    // Idempotent: a second login+verify re-materializes the SAME shape (still
    // one device, same id/secretEnc), never duplicating or corrupting it.
    const login2 = await post(app, '/auth/login', { username: 'dewi', password: PW });
    const verify2 = await post(app, '/auth/totp', { code: authenticator.generate(secret) }, cookieFrom(login2));
    expect(verify2.status).toBe(200);
    const afterSecond = await stored(store, 'dewi');
    expect(afterSecond.totpDevices).toHaveLength(1);
    expect(afterSecond.totpDevices![0]!.secretEnc).toBe(afterFirst.totpDevices![0]!.secretEnc);
    expect(afterSecond.totpDevices![0]!.lastUsedAt).not.toBe(afterFirst.totpDevices![0]!.lastUsedAt); // freshly re-stamped
  });

  it('the migration survives a process restart (FileStore reopened from disk)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccp-totpdev-'));
    try {
      const file = join(dir, 'ccp.json');
      const secret = authenticator.generateSecret();
      const { getCipher } = await import('../src/auth/totp');
      let store: ConfigStore = await FileStore.open(file);
      await seedAccount(store, {
        id: 'dewi',
        role: 'lead',
        totp: { secretEnc: getCipher().enc(secret), enrolledAt: '2026-07-11T00:00:00.000Z' },
      });
      let app = createApp(store);
      const login = await post(app, '/auth/login', { username: 'dewi', password: PW });
      const verify = await post(app, '/auth/totp', { code: authenticator.generate(secret) }, cookieFrom(login));
      expect(verify.status).toBe(200);
      const beforeRestart = await stored(store, 'dewi');
      expect(beforeRestart.totpDevices).toHaveLength(1);

      // Simulate a restart: a brand-new store instance reading the same file.
      store = await FileStore.open(file);
      const afterRestart = await stored(store, 'dewi');
      expect(afterRestart.totp).toBeUndefined();
      expect(afterRestart.totpDevices).toEqual(beforeRestart.totpDevices);

      // And the migrated shape keeps working end to end post-restart.
      app = createApp(store);
      const login2 = await post(app, '/auth/login', { username: 'dewi', password: PW });
      const verify2 = await post(app, '/auth/totp', { code: authenticator.generate(secret) }, cookieFrom(login2));
      expect(verify2.status).toBe(200);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a PRESENT-but-empty totpDevices array is authoritative — never resurrects a legacy secret', async () => {
    const { totpDevicesOf } = await import('../src/auth/totp');
    expect(totpDevicesOf({ totpDevices: [], totp: { secretEnc: 'x', enrolledAt: 'y' } })).toEqual([]);
  });
});

/* ── self-service device routes (§5) ─────────────────────────────────────── */

describe('POST /auth/totp-devices (begin) + /confirm — add a NAMED device', () => {
  it('a plain requester can OPT IN voluntarily (no needsTotp requirement)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    expect((await login.json()).totpRequired).toBeUndefined(); // no forced enrolment
    const cookie = cookieFrom(login);
    const reauth = await post(app, '/auth/reauth', { password: PW }, cookie);
    expect(reauth.status).toBe(200);

    const begin = await post(app, '/auth/totp-devices', {}, cookie);
    expect(begin.status).toBe(200);
    const { secret, otpauthUri } = await begin.json();
    expect(otpauthUri).toContain('otpauth://totp/');

    const confirm = await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret), name: 'My phone' }, cookie);
    expect(confirm.status).toBe(200);
    const body = await confirm.json();
    expect(body.name).toBe('My phone');
    expect(body.recoveryCodes).toHaveLength(10); // account's FIRST device auto-issues codes

    const acc = await stored(store, 'sari');
    expect(acc.totpDevices).toHaveLength(1);
    expect(acc.totpDevices![0]!.name).toBe('My phone');
    expect(acc.recoveryCodes!.codes).toHaveLength(10);
  });

  it('a second device is named independently and does NOT re-issue recovery codes', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');

    const begin2 = await post(app, '/auth/totp-devices', {}, cookie);
    const { secret: secret2 } = await begin2.json();
    const confirm2 = await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret2), name: 'Work laptop' }, cookie);
    expect(confirm2.status).toBe(200);
    const body2 = await confirm2.json();
    expect(body2.recoveryCodes).toBeUndefined(); // NOT the first device

    const acc = await stored(store, 'putra');
    expect(acc.totpDevices!.map((d) => d.name).sort()).toEqual(['Authenticator', 'Work laptop']);
    expect(acc.recoveryCodes!.codes).toHaveLength(10); // issued once, at the FIRST device
  });

  it('refuses at the 5-device cap (DEVICE_LIMIT) — both at begin and at confirm', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');

    for (let i = 0; i < 4; i++) {
      const begin = await post(app, '/auth/totp-devices', {}, cookie);
      const { secret } = await begin.json();
      const confirm = await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret), name: `Device ${i}` }, cookie);
      expect(confirm.status, `device ${i}`).toBe(200);
    }
    expect((await stored(store, 'putra')).totpDevices).toHaveLength(5);

    const begin6 = await post(app, '/auth/totp-devices', {}, cookie);
    expect(begin6.status).toBe(422);
    expect((await begin6.json()).code).toBe('DEVICE_LIMIT');
  });

  it('device name validation: empty, oversize (>40), and control characters all 422', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');
    const begin = await post(app, '/auth/totp-devices', {}, cookie);
    const { secret } = await begin.json();
    const code = authenticator.generate(secret);

    for (const name of ['', '   ', 'x'.repeat(41), 'line1\nline2', 'tab\tinside']) {
      const confirm = await post(app, '/auth/totp-devices/confirm', { code, name }, cookie);
      expect(confirm.status, JSON.stringify(name)).toBe(422);
    }
  });

  it('a wrong code at confirm refuses TOTP_REQUIRED and leaves the device list UNCHANGED', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    // loginAndElevate itself enrols device #1 (forced first-login enrolment for
    // a lead+isAdmin account) — the baseline this refusal must not disturb.
    const cookie = await loginAndElevate(app, 'putra');
    const before = await stored(store, 'putra');
    expect(before.totpDevices).toHaveLength(1);

    await post(app, '/auth/totp-devices', {}, cookie);
    const confirm = await post(app, '/auth/totp-devices/confirm', { code: '000000', name: 'x' }, cookie);
    expect(confirm.status).toBe(401);
    expect((await confirm.json()).code).toBe('TOTP_REQUIRED');
    expect((await stored(store, 'putra')).totpDevices).toEqual(before.totpDevices);
  });

  it('the add offer expires after TOTP_PENDING_MS (5 minutes)', async () => {
    const { __setNow } = await import('../src/clock');
    try {
      const T0 = Date.UTC(2026, 6, 11, 9, 0, 0);
      __setNow(() => T0);
      const store = new MemoryStore();
      await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
      const app = createApp(store);
      const cookie = await loginAndElevate(app, 'putra');
      const begin = await post(app, '/auth/totp-devices', {}, cookie);
      const { secret } = await begin.json();

      __setNow(() => T0 + 5 * 60_000 + 1000); // 5m + 1s later
      const confirm = await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret), name: 'x' }, cookie);
      expect(confirm.status).toBe(401);
      expect((await confirm.json()).code).toBe('TOTP_REQUIRED');
    } finally {
      __setNow(null);
    }
  });

  it('every device mutation is audited (totp-device-add, and recovery-codes-generate on the first)', async () => {
    const store = new MemoryStore();
    // '*'-bound so this same account can also read the @control audit chain below.
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true, roles: { '*': { role: 'lead', teamId: 'platform' } } });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');
    const begin = await post(app, '/auth/totp-devices', {}, cookie);
    const { secret } = await begin.json();
    await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret), name: 'Named phone' }, cookie);

    const exp = await (await app.request('/admin/audit/export', { headers: { cookie, 'x-ccp-project': '@control' } })).json();
    expect(exp.entries, JSON.stringify(exp)).toBeDefined();
    const actions = (exp.entries as ChainEntry[]).filter((e) => e.actor === 'putra').map((e) => e.action);
    expect(actions).toContain('totp-device-add');
    expect(actions).toContain('recovery-codes-generate');
    const addEntry = (exp.entries as ChainEntry[]).find((e) => e.action === 'totp-device-add')!;
    expect((addEntry.after as { name: string }).name).toBe('Named phone');
    // Never any secret material in the audit payload.
    expect(JSON.stringify(addEntry)).not.toContain(secret);
  });
});

describe('DELETE /auth/totp-devices/:id — remove, with the last-factor guard', () => {
  it('removing one of several devices is always allowed, regardless of needsTotp', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');
    const begin2 = await post(app, '/auth/totp-devices', {}, cookie);
    const { secret: secret2 } = await begin2.json();
    await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret2), name: 'Second' }, cookie);

    const before = await stored(store, 'putra');
    expect(before.totpDevices).toHaveLength(2);
    const toRemove = before.totpDevices!.find((d) => d.name === 'Second')!;

    const res = await del(app, `/auth/totp-devices/${toRemove.id}`, cookie);
    expect(res.status).toBe(200);
    const after = await stored(store, 'putra');
    expect(after.totpDevices).toHaveLength(1);
    expect(after.totpDevices![0]!.name).toBe('Authenticator');
    expect(after.recoveryCodes).toBeDefined(); // still 2FA-active — codes survive
  });

  it('LAST_FACTOR: removing the ONLY device while needsTotp is true is refused', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true }); // needsTotp true (lead + isAdmin)
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');
    const device = (await stored(store, 'putra')).totpDevices![0]!;

    const res = await del(app, `/auth/totp-devices/${device.id}`, cookie);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('LAST_FACTOR');
    expect((await stored(store, 'putra')).totpDevices).toHaveLength(1); // untouched
  });

  it('removing the LAST device is allowed once needsTotp is false, and clears recovery codes too (audited both)', async () => {
    const store = new MemoryStore();
    // '*'-bound admin observer, purely to read the @control audit chain below.
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true, roles: { '*': { role: 'lead', teamId: 'platform' } } });
    // Requester who opted in voluntarily — needsTotp is false for them.
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login);
    await post(app, '/auth/reauth', { password: PW }, cookie);
    const begin = await post(app, '/auth/totp-devices', {}, cookie);
    const { secret } = await begin.json();
    await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret), name: 'Only one' }, cookie);
    expect((await stored(store, 'sari')).recoveryCodes).toBeDefined();

    const device = (await stored(store, 'sari')).totpDevices![0]!;
    const res = await del(app, `/auth/totp-devices/${device.id}`, cookie);
    expect(res.status).toBe(200);
    const after = await stored(store, 'sari');
    expect(after.totpDevices).toEqual([]);
    expect(after.recoveryCodes).toBeUndefined();

    const adminCookie = await loginAndElevate(app, 'putra');
    const exp = await (await app.request('/admin/audit/export', { headers: { cookie: adminCookie, 'x-ccp-project': '@control' } })).json();
    expect(exp.entries, JSON.stringify(exp)).toBeDefined();
    const actions = (exp.entries as ChainEntry[]).filter((e) => e.actor === 'sari').map((e) => e.action);
    expect(actions).toContain('totp-device-remove');
    expect(actions).toContain('recovery-codes-clear');
  });

  it('removing an unknown device id 404s', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = createApp(store);
    const cookie = await loginAndElevate(app, 'putra');
    const res = await del(app, '/auth/totp-devices/does-not-exist', cookie);
    expect(res.status).toBe(404);
  });

  it('LAST_FACTOR also protects the founding predicate\'s truth value: needsTotp(a) reads identically pre/post migration', async () => {
    const { needsTotp, totpDevicesOf } = await import('../src/auth/totp');
    const legacyEnrolled = { role: 'lead' as const, isAdmin: false, totp: { secretEnc: 'x', enrolledAt: 'y' } };
    const migrated = { role: 'lead' as const, isAdmin: false, totpDevices: [{ id: 'a', name: 'x', secretEnc: 'x', enrolledAt: 'y' }] };
    expect(needsTotp(legacyEnrolled)).toBe(needsTotp(migrated));
    expect(totpDevicesOf(legacyEnrolled).length > 0).toBe(totpDevicesOf(migrated).length > 0);
  });
});

describe('device add/remove all require a FRESH re-auth elevation (⚿)', () => {
  it('POST /auth/totp-devices without a fresh reauth refuses REAUTH_REQUIRED', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const cookie = cookieFrom(login); // never called /auth/reauth
    const res = await post(app, '/auth/totp-devices', {}, cookie);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('REAUTH_REQUIRED');
  });

  it('GET /auth/totp-devices (a READ) needs no re-auth at all', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const app = createApp(store);
    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    const res = await get(app, '/auth/totp-devices', cookieFrom(login));
    expect(res.status).toBe(200);
  });
});

/* ── admin reset-totp now clears ALL devices + recovery codes ─────────────── */

describe('POST /admin/accounts/:id/reset-totp — clears ALL devices + recovery codes', () => {
  it('a multi-device, code-issued account is fully wiped by one admin reset', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true, roles: { '*': { role: 'lead', teamId: 'platform' } } });
    await seedAccount(store, { id: 'dewi', role: 'lead' });
    const app = createApp(store);
    const dewiCookie = await loginAndElevate(app, 'dewi');
    const begin2 = await post(app, '/auth/totp-devices', {}, dewiCookie);
    const { secret: secret2 } = await begin2.json();
    await post(app, '/auth/totp-devices/confirm', { code: authenticator.generate(secret2), name: 'Second' }, dewiCookie);
    expect((await stored(store, 'dewi')).totpDevices).toHaveLength(2);
    expect((await stored(store, 'dewi')).recoveryCodes).toBeDefined();

    const adminCookie = await loginAndElevate(app, 'putra');
    const reset = await app.request('/admin/accounts/dewi/reset-totp', { method: 'POST', headers: { ...CH, cookie: adminCookie } });
    expect(reset.status).toBe(200);

    const after = await stored(store, 'dewi');
    expect(after.totp).toBeUndefined();
    expect(after.totpDevices).toBeUndefined();
    expect(after.recoveryCodes).toBeUndefined();
  });
});
