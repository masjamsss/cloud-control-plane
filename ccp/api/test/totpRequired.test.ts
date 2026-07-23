import { beforeEach, describe, expect, it } from 'vitest';
import { authenticator } from 'otplib';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, type AccountItem } from '../src/store/schema';
import { hashPassword } from '../src/auth/credentials';
import { mintSession } from '../src/auth/sessions';
import { needsTotp } from '../src/auth/totp';
import { requireSession } from '../src/middleware/session';
import { __setKnownProjects } from '../src/projects';
import type { ChainEntry } from '../src/domain/audit';

// data-birth: this file's fixtures build accounts directly (no test/helpers/seed.ts
// seed(), so no 'sample'-scoped team/policy footprint for the legacy settlement
// (domain/settlement.ts) to organically retro-register 'sample' from) — pin it known
// explicitly, same as any other non-default-shaped test store.
beforeEach(() => __setKnownProjects(['sample']));

/**
 * Feature A (proposal 0037 §2) — admin-controlled per-user 2FA requirement.
 *
 * The effective requirement is `account.totpRequired ?? (role !== 'requester' ||
 * isAdmin)`, so every legacy row (no `totpRequired`) behaves exactly as before,
 * and an admin can flip it true/false for ANYONE (no server role floor — the
 * downgrade warning is a UI safety net, proven app-side). Switching off never
 * deletes the enrolled factor.
 *
 * ADR-0024 clause 4 (account & security center, 2026-07-22) supersedes ADR-0013's
 * "dormant secret" clause in part: an ENROLLED factor is now ALWAYS challenged at
 * login, even when `totpRequired` is pinned false — `needsTotp` keeps its exact
 * meaning ("must this account HAVE a factor," drives forced enrolment + the
 * last-device guard), but possession of an enrolled device now always engages
 * the login challenge. An admin `totpRequired:false` pin no longer silently
 * stops challenging an already-enrolled account; a user who wants no challenge
 * removes their device(s) in self-service instead (an explicit, audited act).
 */

const PW = 'correct-horse-battery-staple';
const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' };

type SeedOver = { id: string; role: AccountItem['role'] } & Partial<AccountItem>;

async function seedAccount(store: ConfigStore, over: SeedOver): Promise<AccountItem> {
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
    ...over, // caller's id/role (+ any override: totpRequired, isAdmin, …)
    ...accountKey(over.id),
    GSI1PK: accountsGsi(),
    GSI1SK: over.id,
  };
  await store.put(item);
  return item;
}

function appWithProtected(store: ConfigStore): Hono<AppEnv> {
  const app = createApp(store);
  app.get('/protected', requireSession, (c) => c.json({ ok: true }));
  return app;
}

function post(app: Hono<AppEnv>, path: string, body: unknown, cookie?: string) {
  const headers: Record<string, string> = { ...CH };
  if (cookie) headers.cookie = cookie;
  return app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
}
// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function patch(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return app.request(path, { method: 'PATCH', headers: { ...CH, cookie, 'x-ccp-project': 'sample' }, body: JSON.stringify(body) });
}
function get(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}
function cookieFrom(res: Response): string {
  const m = /ccp_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  return m ? `ccp_session=${m[1]}` : '';
}
async function stored(store: ConfigStore, id: string): Promise<AccountItem> {
  return (await store.get(accountKey(id).PK, 'META')) as AccountItem;
}
/** An admin session cookie (bypasses login/TOTP — we test the admin route, not login). */
async function adminCookie(store: ConfigStore, id: string): Promise<string> {
  const acc = await stored(store, id);
  return `ccp_session=${await mintSession(store, id, acc.sessionVersion)}`;
}

/* ── the effective-requirement helper (the single source of truth) ─────────── */

describe('needsTotp — effective requirement truth table', () => {
  // On the MATERIALIZED shape (explicit `roles`) — the shape every account
  // actually has by the time `needsTotp` reads it in the live request path
  // (see perProjectAuthz.test.ts's identical note: a bare row's arm-3 fallback
  // is retired to `{}`, data-birth spec §5 — settlement materializes first).
  it('role default (undefined totpRequired) reproduces the pre-0037 behaviour', () => {
    expect(needsTotp({ roles: { sample: { role: 'requester' } }, isAdmin: false })).toBe(false);
    expect(needsTotp({ roles: { sample: { role: 'approver' } }, isAdmin: false })).toBe(true);
    expect(needsTotp({ roles: { sample: { role: 'lead' } }, isAdmin: false })).toBe(true);
    // isAdmin lifts a plain requester into "required".
    expect(needsTotp({ roles: { sample: { role: 'requester' } }, isAdmin: true })).toBe(true);
  });

  it('explicit true forces 2FA even for a plain requester', () => {
    expect(needsTotp({ role: 'requester', isAdmin: false, totpRequired: true })).toBe(true);
  });

  it('explicit false exempts a privileged account (no server role floor)', () => {
    expect(needsTotp({ role: 'approver', isAdmin: false, totpRequired: false })).toBe(false);
    expect(needsTotp({ role: 'lead', isAdmin: false, totpRequired: false })).toBe(false);
    // isAdmin does NOT re-impose it — the explicit override wins.
    expect(needsTotp({ role: 'requester', isAdmin: true, totpRequired: false })).toBe(false);
  });

  it('an explicit value that equals the role default is a harmless no-op', () => {
    expect(needsTotp({ role: 'approver', isAdmin: false, totpRequired: true })).toBe(true);
    expect(needsTotp({ role: 'requester', isAdmin: false, totpRequired: false })).toBe(false);
  });
});

/* ── admin route: full control + audit + mass-assignment discipline ────────── */

describe('PATCH /admin/accounts/:id — totpRequired', () => {
  async function setup(): Promise<{ app: Hono<AppEnv>; store: ConfigStore; admin: string }> {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true });
    const app = appWithProtected(store);
    return { app, store, admin: await adminCookie(store, 'putra') };
  }

  it('turning 2FA ON for a plain requester applies immediately (200) and is audited before/after the flag', async () => {
    const { app, store, admin } = await setup();
    await seedAccount(store, { id: 'sari', role: 'requester' });

    const res = await patch(app, admin, '/admin/accounts/sari', { totpRequired: true });
    expect(res.status).toBe(200);
    expect(await stored(store, 'sari').then((a) => a.totpRequired)).toBe(true);

    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    const entry = (exp.entries as ChainEntry[]).find(
      (e) => e.action === 'account-update' && e.targetId === 'sari',
    );
    expect(entry, 'a 2FA change is one audited mutation').toBeTruthy();
    expect((entry!.after as { totpRequired?: boolean }).totpRequired).toBe(true);
    expect((entry!.before as { totpRequired?: boolean }).totpRequired).toBeUndefined();
  });

  it('turning 2FA OFF for a PRIVILEGED account is permitted (200) and audited — no server role floor', async () => {
    const { app, store, admin } = await setup();
    await seedAccount(store, { id: 'lina', role: 'lead' }); // privileged, another lead so no last-lead guard

    const res = await patch(app, admin, '/admin/accounts/lina', { totpRequired: false });
    expect(res.status).toBe(200); // NOT 202 — the server never gates the downgrade behind a second admin
    expect(await stored(store, 'lina').then((a) => a.totpRequired)).toBe(false);
    // login now skips the second factor for this privileged account.
    expect(needsTotp(await stored(store, 'lina'))).toBe(false);

    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    const entry = (exp.entries as ChainEntry[]).find(
      (e) => e.action === 'account-update' && e.targetId === 'lina',
    );
    expect((entry!.after as { totpRequired?: boolean }).totpRequired).toBe(false);
  });

  it('mass-assignment discipline: only totpRequired lands — non-whitelisted body fields are ignored', async () => {
    const { app, store, admin } = await setup();
    await seedAccount(store, { id: 'mass', role: 'requester' });
    const before = await stored(store, 'mass');

    const res = await patch(app, admin, '/admin/accounts/mass', {
      totpRequired: true,
      // none of these are settable through this route — they must be stripped:
      sessionVersion: 999,
      mustChangePassword: true,
      credential: { algo: 'pbkdf2', hash: 'evil' },
      totp: { secretEnc: 'evil', enrolledAt: '2026-07-11T00:00:00.000Z' },
    });
    expect(res.status).toBe(200);

    const after = await stored(store, 'mass');
    expect(after.totpRequired).toBe(true); // the one allowed field applied
    expect(after.sessionVersion).toBe(before.sessionVersion); // untouched
    expect(after.mustChangePassword).toBe(false); // untouched
    expect(after.credential.algo).toBe('argon2id'); // untouched
    expect(after.totp).toBeUndefined(); // a client can NEVER inject an enrolled factor
  });

  it('a non-admin requester → 403 NOT_ADMIN', async () => {
    const { app, store } = await setup();
    await seedAccount(store, { id: 'sari', role: 'requester' });
    const sari = await adminCookie(store, 'sari');
    const res = await patch(app, sari, '/admin/accounts/sari', { totpRequired: false });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });
});

/* ── login: the effective flag drives the step machine, secret stays dormant ─ */

describe('login honours the effective 2FA requirement', () => {
  it('a requester with totpRequired:true is forced to ENROL a second factor', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'sari', role: 'requester', totpRequired: true });
    const app = appWithProtected(store);

    const login = await post(app, '/auth/login', { username: 'sari', password: PW });
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.totpRequired).toBe(true);
    expect(body.totpEnrollment.otpauthUri).toContain('otpauth://totp/'); // not-yet-enrolled → enrol
    // the pre-session cannot reach a protected route until the factor is bound.
    const prot = await app.request('/protected', { headers: { cookie: cookieFrom(login) } });
    expect(prot.status).toBe(401);
  });

  it('a privileged account with totpRequired:false SKIPS the 2FA step and opens a full session', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'lina', role: 'lead', totpRequired: false });
    const app = appWithProtected(store);

    const login = await post(app, '/auth/login', { username: 'lina', password: PW });
    expect(login.status).toBe(200);
    const body = await login.json();
    expect(body.totpRequired).toBeUndefined(); // no second factor demanded
    // straight to a FULL session — the protected route is reachable immediately.
    expect((await app.request('/protected', { headers: { cookie: cookieFrom(login) } })).status).toBe(200);
  });

  it('ADR-0024 clause 4: an enrolled factor is ALWAYS challenged — toggling totpRequired OFF never stops it, and the same device keeps verifying (never deleted, never replaced)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'putra', role: 'lead', isAdmin: true }); // the admin doing the toggling
    await seedAccount(store, { id: 'dewi', role: 'lead' }); // privileged target, un-enrolled
    const app = appWithProtected(store);
    const admin = await adminCookie(store, 'putra');

    // 1) dewi logs in and enrols her authenticator for the first time — this
    // is also the FIRST device write, so it materializes totpDevices (ADR-0024
    // clause 2) and the legacy `totp` field is gone from here on.
    const first = await post(app, '/auth/login', { username: 'dewi', password: PW });
    const { totpEnrollment } = await first.json();
    const secret: string = totpEnrollment.secret;
    const enroll = await post(app, '/auth/totp/enroll', { code: authenticator.generate(secret) }, cookieFrom(first));
    expect(enroll.status).toBe(200);
    const before = await stored(store, 'dewi');
    expect(before.totp).toBeUndefined(); // materialized away
    expect(before.totpDevices).toHaveLength(1);
    const secretEnc0 = before.totpDevices![0]!.secretEnc;

    // 2) admin turns 2FA OFF — the device must survive, never be deleted.
    expect((await patch(app, admin, '/admin/accounts/dewi', { totpRequired: false })).status).toBe(200);
    expect((await stored(store, 'dewi')).totpDevices![0]!.secretEnc).toBe(secretEnc0);

    // 3) dewi logs in again — STILL challenged (clause 4: possession of an
    // enrolled device always engages the login challenge; the totpRequired:false
    // pin no longer silently stops it). This is the exact behavior change
    // ADR-0024 clause 4 makes, deliberately superseding ADR-0013's dormancy.
    const stillChallenged = await post(app, '/auth/login', { username: 'dewi', password: PW });
    expect(stillChallenged.status).toBe(200);
    const challengedBody = await stillChallenged.json();
    expect(challengedBody.totpRequired).toBe(true);
    expect(challengedBody.totpEnrollment).toBeUndefined(); // already enrolled — a verify step, not enrolment
    const preCookie = cookieFrom(stillChallenged);
    expect((await app.request('/protected', { headers: { cookie: preCookie } })).status).toBe(401); // pre-session only
    const verifyWhileOff = await post(app, '/auth/totp', { code: authenticator.generate(secret) }, preCookie);
    expect(verifyWhileOff.status).toBe(200); // the same device still satisfies the challenge
    expect((await app.request('/protected', { headers: { cookie: cookieFrom(verifyWhileOff) } })).status).toBe(200);

    // 4) admin turns 2FA back ON — orthogonal to the challenge (already
    // happening either way), but still a legal, audited immediate write.
    expect((await patch(app, admin, '/admin/accounts/dewi', { totpRequired: true })).status).toBe(200);

    // 5) next login is STILL a VERIFY step against the SAME device — never a
    // fresh enrolment, never a replaced secret, throughout the whole toggle.
    const reLogin = await post(app, '/auth/login', { username: 'dewi', password: PW });
    const reBody = await reLogin.json();
    expect(reBody.totpRequired).toBe(true);
    expect(reBody.totpEnrollment).toBeUndefined();
    const verify = await post(app, '/auth/totp', { code: authenticator.generate(secret) }, cookieFrom(reLogin));
    expect(verify.status).toBe(200); // the ORIGINAL secret still verifies
    expect((await stored(store, 'dewi')).totpDevices![0]!.secretEnc).toBe(secretEnc0); // byte-identical throughout
  });

  it('a NON-enrolled account with totpRequired:false truly skips the step (no device to challenge)', async () => {
    const store = new MemoryStore();
    await seedAccount(store, { id: 'lina', role: 'lead', totpRequired: false }); // privileged, exempted, never enrolled
    const app = appWithProtected(store);

    const login = await post(app, '/auth/login', { username: 'lina', password: PW });
    expect(login.status).toBe(200);
    expect((await login.json()).totpRequired).toBeUndefined();
    expect((await app.request('/protected', { headers: { cookie: cookieFrom(login) } })).status).toBe(200);
  });
});
