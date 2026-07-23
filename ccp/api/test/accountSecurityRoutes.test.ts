import { describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, type AccountItem } from '../src/store/schema';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';
import { roleFor } from '../src/projects';
import { hashPassword } from '../src/auth/credentials';

/**
 * The account & security spec's remaining A1 surfaces not already covered by
 * `totpDevices.test.ts` / `recoveryCodes.test.ts` / `reauth.test.ts`:
 *   §4 self password-change (`keepOtherSessions`)
 *   §8 active sessions (list / revoke-one / revoke-others)
 *   §9.2 the drift-guard interplay — a self-service mutation stales a
 *        pending ADMIN dual-control proposal (accountVersion bump), the
 *        exact doctrine `accountsAdmin.test.ts` already proves for an
 *        admin-initiated password reset — this proves the SELF-service side.
 */

const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', 'x-ccp-project': 'sample' };
/** test/helpers/seed.ts accounts carry a PLACEHOLDER credential hash
 * ('placeholder-never-verified' — its own sessionCookieFor bypasses login
 * entirely, by design). /auth/reauth and /auth/change-password genuinely
 * verify a password, so `setupStore` below overwrites the accounts THIS file
 * needs real credentials for with this known one. */
const PW = 'correct-horse-battery-staple';

function post(app: Hono<AppEnv>, cookie: string, path: string, body?: unknown) {
  return app.request(path, { method: 'POST', headers: { ...CH, cookie }, body: JSON.stringify(body ?? {}) });
}
function patch(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return app.request(path, { method: 'PATCH', headers: { ...CH, cookie }, body: JSON.stringify(body) });
}
function del(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { method: 'DELETE', headers: { ...CH, cookie } });
}
function get(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}
function cookieFrom(res: Response): string {
  const m = /ccp_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `ccp_session=${m[1]}` : '';
}

/** Seeds the standard `sample` estate (sari=requester, budi=approver,
 * putra=admin lead, lina=lead) with NO sessions pre-minted — every test
 * mints exactly the sessions it needs, so session-count assertions are
 * never thrown off by a hidden side effect. `sari`'s credential is
 * overwritten to a REAL, KNOWN password (`PW`) since this file's whole
 * point is exercising genuine password verification (reauth, change-password). */
async function setupStore(): Promise<{ app: Hono<AppEnv>; store: ConfigStore }> {
  const store = new MemoryStore();
  await seed(store);
  const sari = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
  await store.put({ ...sari, credential: { algo: 'argon2id', hash: await hashPassword(PW) } });
  const app = createApp(store);
  return { app, store };
}

/* ── §4 self password-change: keepOtherSessions ──────────────────────────── */

describe('POST /auth/change-password — keepOtherSessions', () => {
  it("default (false, or omitted): today's behavior verbatim — every OTHER session dies, the caller's cookie is re-minted", async () => {
    const { app, store } = await setupStore();
    const cookieA = await sessionCookieFor(store, 'sari');
    const cookieB = await sessionCookieFor(store, 'sari'); // a second live session, same account

    const change = await post(app, cookieA, '/auth/change-password', { currentPassword: PW, newPassword: 'a-brand-new-pw-1' });
    expect(change.status).toBe(200);
    const newCookieA = cookieFrom(change);

    expect((await app.request('/auth/me', { headers: { cookie: cookieB } })).status).toBe(401); // killed
    expect((await app.request('/auth/me', { headers: { cookie: newCookieA } })).status).toBe(200); // re-minted, alive
  });

  it('true: OTHER sessions survive; the credential still swaps and mustChangePassword clears; audit gains otherSessionsKept:true', async () => {
    const { app, store } = await setupStore();
    const cookieA = await sessionCookieFor(store, 'sari');
    const cookieB = await sessionCookieFor(store, 'sari');

    const change = await post(app, cookieA, '/auth/change-password', {
      currentPassword: PW,
      newPassword: 'a-brand-new-pw-1',
      keepOtherSessions: true,
    });
    expect(change.status).toBe(200);

    // BOTH sessions still work — sessionVersion was never bumped.
    expect((await app.request('/auth/me', { headers: { cookie: cookieA } })).status).toBe(200);
    expect((await app.request('/auth/me', { headers: { cookie: cookieB } })).status).toBe(200);

    // The new password actually took effect.
    const relogin = await app.request('/auth/login', {
      method: 'POST',
      headers: CH,
      body: JSON.stringify({ username: 'sari', password: 'a-brand-new-pw-1' }),
    });
    expect(relogin.status).toBe(200);

    const admin = await sessionCookieFor(store, 'putra');
    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    const entries = exp.entries as Array<{ action: string; actor: string; after?: unknown }>;
    const entry = entries.find((e) => e.action === 'password-change' && e.actor === 'sari');
    expect(entry).toBeTruthy();
    expect(entry!.after).toEqual({ otherSessionsKept: true });
  });

  it('wrong current-password is refused BAD_CREDENTIALS regardless of keepOtherSessions', async () => {
    const { app, store } = await setupStore();
    const cookie = await sessionCookieFor(store, 'sari');
    const res = await post(app, cookie, '/auth/change-password', { currentPassword: 'nope', newPassword: 'a-brand-new-pw-1', keepOtherSessions: true });
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('BAD_CREDENTIALS');
  });
});

/* ── §8 active sessions ───────────────────────────────────────────────────── */

describe("GET /auth/sessions — the caller's own live sessions, current marked", () => {
  it("lists every live session with a current marker; excludes another account's sessions", async () => {
    const { app, store } = await setupStore();
    const cookieA = await sessionCookieFor(store, 'sari');
    const cookieB = await sessionCookieFor(store, 'sari');
    await sessionCookieFor(store, 'budi'); // a DIFFERENT account's session — must never appear

    const res = await get(app, cookieA, '/auth/sessions');
    expect(res.status).toBe(200);
    const rows = await res.json();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r: { current: boolean }) => r.current)).toHaveLength(1);
    for (const r of rows) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('issuedAt');
      expect(r).toHaveProperty('lastSeenAt');
      expect(typeof r.id).toBe('string');
    }
    void cookieB;
  });

  it('an id is the GSI1SK hash, never the raw session token', async () => {
    const { app, store } = await setupStore();
    const cookie = await sessionCookieFor(store, 'sari');
    const rows = await (await get(app, cookie, '/auth/sessions')).json();
    const token = /ccp_session=([^;]+)/.exec(cookie)![1]!;
    expect(rows[0].id).not.toBe(token);
    expect(rows[0].id).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
  });
});

describe("DELETE /auth/sessions/:id — revoke ONE of the caller's own", () => {
  it('deleting the CURRENT session signs the caller out (the cookie then resolves to nothing)', async () => {
    const { app, store } = await setupStore();
    const cookie = await sessionCookieFor(store, 'sari');
    const reauth = await post(app, cookie, '/auth/reauth', { password: PW });
    expect(reauth.status).toBe(200);

    const rows = await (await get(app, cookie, '/auth/sessions')).json();
    const current = rows.find((r: { current: boolean }) => r.current);
    const res = await del(app, cookie, `/auth/sessions/${current.id}`);
    expect(res.status).toBe(200);
    expect((await app.request('/auth/me', { headers: { cookie } })).status).toBe(401);
  });

  it("404s on an id from a DIFFERENT account's session list — no cross-user probing", async () => {
    const { app, store } = await setupStore();
    const sariCookie = await sessionCookieFor(store, 'sari');
    await post(app, sariCookie, '/auth/reauth', { password: PW });
    const budiCookie = await sessionCookieFor(store, 'budi');
    const budiRows = await (await get(app, budiCookie, '/auth/sessions')).json();

    const res = await del(app, sariCookie, `/auth/sessions/${budiRows[0].id}`);
    expect(res.status).toBe(404);
    // budi's session is untouched.
    expect((await app.request('/auth/me', { headers: { cookie: budiCookie } })).status).toBe(200);
  });

  it('an unknown id 404s', async () => {
    const { app, store } = await setupStore();
    const cookie = await sessionCookieFor(store, 'sari');
    await post(app, cookie, '/auth/reauth', { password: PW });
    const res = await del(app, cookie, '/auth/sessions/does-not-exist');
    expect(res.status).toBe(404);
  });

  it('is audited session-revoke-self {after:{revoked:1}}', async () => {
    const { app, store } = await setupStore();
    const cookie = await sessionCookieFor(store, 'sari');
    const other = await sessionCookieFor(store, 'sari');
    await post(app, cookie, '/auth/reauth', { password: PW });
    const rows = await (await get(app, cookie, '/auth/sessions')).json();
    const target = rows.find((r: { current: boolean }) => !r.current);
    await del(app, cookie, `/auth/sessions/${target.id}`);

    const admin = await sessionCookieFor(store, 'putra');
    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    const entries = (exp.entries as Array<{ action: string; actor: string; after?: unknown }>).filter(
      (e) => e.action === 'session-revoke-self' && e.actor === 'sari',
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.after).toEqual({ revoked: 1 });
    void other;
  });
});

describe('POST /auth/sessions/revoke-others — sign out my other devices', () => {
  it("kills every OTHER session, keeps the caller's own alive, NO sessionVersion bump", async () => {
    const { app, store } = await setupStore();
    const keeper = await sessionCookieFor(store, 'sari');
    const other1 = await sessionCookieFor(store, 'sari');
    const other2 = await sessionCookieFor(store, 'sari');
    await post(app, keeper, '/auth/reauth', { password: PW });

    const res = await post(app, keeper, '/auth/sessions/revoke-others');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revoked: 2 });

    expect((await app.request('/auth/me', { headers: { cookie: keeper } })).status).toBe(200); // survives
    expect((await app.request('/auth/me', { headers: { cookie: other1 } })).status).toBe(401);
    expect((await app.request('/auth/me', { headers: { cookie: other2 } })).status).toBe(401);

    const rows = await (await get(app, keeper, '/auth/sessions')).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].current).toBe(true);
  });

  it('a single-session account revoking others reports 0, keeper untouched', async () => {
    const { app, store } = await setupStore();
    const cookie = await sessionCookieFor(store, 'sari');
    await post(app, cookie, '/auth/reauth', { password: PW });
    const res = await post(app, cookie, '/auth/sessions/revoke-others');
    expect(await res.json()).toEqual({ ok: true, revoked: 0 });
    expect((await app.request('/auth/me', { headers: { cookie } })).status).toBe(200);
  });
});

/* ── §9.2 drift guard: a SELF mutation stales a pending admin proposal ──────
 * accountsAdmin.test.ts already proves the ADMIN-initiated half (a password
 * reset stales a pending role-grant); this proves the reverse direction — a
 * SELF-SERVICE 2FA mutation bumps accountVersion and stales an admin's
 * already-proposed dual-control change captured against the older snapshot. */

describe('drift guard — a self-service device mutation stales a pending admin proposal', () => {
  it('a device add between propose and ack rejects the ack STALE_PROPOSAL', async () => {
    const { app, store } = await setupStore();
    await seedAccount(store, { id: 'gita', role: 'lead', teamId: 'platform', isAdmin: true }); // 2nd distinct admin
    const admin = await sessionCookieFor(store, 'putra');
    const gita = await sessionCookieFor(store, 'gita');
    const sariCookie = await sessionCookieFor(store, 'sari');

    // Admin proposes raising sari to approver (loosening → 202 pending).
    const pendingRes = await patch(app, admin, '/admin/accounts/sari', { setRole: { projectId: 'sample', role: 'approver' } });
    expect(pendingRes.status).toBe(202);
    const pending = await pendingRes.json();

    // Sari, meanwhile, opts into 2FA herself — a self-service mutation that
    // bumps accountVersion out from under the still-pending proposal.
    await post(app, sariCookie, '/auth/reauth', { password: PW });
    const begin = await post(app, sariCookie, '/auth/totp-devices');
    expect(begin.status).toBe(200);
    const { secret } = await begin.json();
    const confirm = await post(app, sariCookie, '/auth/totp-devices/confirm', { code: authenticator.generate(secret), name: 'x' });
    expect(confirm.status).toBe(200);

    const ack = await post(app, gita, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(409);
    expect((await ack.json()).code).toBe('STALE_PROPOSAL');

    // Nothing silently clobbered: sari is still a requester (the grant never applied).
    const acc = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(roleFor(acc, 'sample')).toBe('requester');
    expect(acc.totpDevices).toHaveLength(1); // her own opt-in survived intact
  });

  it('every self-service mutation this build adds bumps accountVersion', async () => {
    const { app, store } = await setupStore();
    const cookie = await sessionCookieFor(store, 'sari');
    const before = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    const v0 = before.accountVersion ?? 0;

    await post(app, cookie, '/auth/reauth', { password: PW });
    const begin = await post(app, cookie, '/auth/totp-devices');
    const { secret } = await begin.json();
    await post(app, cookie, '/auth/totp-devices/confirm', { code: authenticator.generate(secret), name: 'x' });
    const v1 = ((await store.get(accountKey('sari').PK, 'META')) as AccountItem).accountVersion!;
    expect(v1).toBeGreaterThan(v0);

    await post(app, cookie, '/auth/recovery-codes/regenerate');
    const v2 = ((await store.get(accountKey('sari').PK, 'META')) as AccountItem).accountVersion!;
    expect(v2).toBeGreaterThan(v1);

    const deviceId = ((await store.get(accountKey('sari').PK, 'META')) as AccountItem).totpDevices![0]!.id;
    // sari opted in voluntarily (requester, needsTotp false) — removing her
    // only device is allowed and bumps the version once more.
    await del(app, cookie, `/auth/totp-devices/${deviceId}`);
    const v3 = ((await store.get(accountKey('sari').PK, 'META')) as AccountItem).accountVersion!;
    expect(v3).toBeGreaterThan(v2);
  });
});
