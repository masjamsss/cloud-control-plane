import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, type AccountItem } from '../src/store/schema';
import type { ChainEntry } from '../src/domain/audit';
import { roleFor, teamFor } from '../src/projects';
import { seed, seedAccount, sessionCookieFor } from './helpers/seed';

/**
 * Cloud Control Plane item B1: the 5 Users-admin actions that were still
 * hardcoded-advisory in the SPA — create/enrol account, set-role, set-team,
 * set-status, reset-password. The backend routes themselves (admin.ts's
 * /accounts, /accounts/:id, /accounts/:id/reset-password) predate this lane —
 * this file is the missing test coverage that proves each is (a) admin-gated,
 * refusing a non-admin caller with 403 NOT_ADMIN, (b) reachable end to end for
 * its happy path (immediate apply OR the correct §6 dual-control 202), and
 * (c) never leaks credential material — the exact regression
 * `domain/dualControl.ts#publicPendingChange` (added alongside this file) now
 * guards: `PendingConfigChangeItem.apply` carries a freshly argon2id-hashed
 * credential for a senior enroll/password-reset, and `apply` was never part of
 * the documented §3 PendingConfigChange contract (openapi/ccp-api.yaml has
 * no `apply` property) — it must never round-trip into a response body.
 *
 * Mirrors adminSurface.test.ts's helper shape (post/patch/get + setup()).
 */

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE). This suite predates that concept
// and always meant "act on the sample estate" — CH carries the project header
// explicitly now, same as the real SPA always does.
const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', 'x-ccp-project': 'sample' };

function post(app: Hono<AppEnv>, cookie: string, path: string, body?: unknown) {
  return app.request(path, { method: 'POST', headers: { ...CH, cookie }, body: JSON.stringify(body ?? {}) });
}
function patch(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return app.request(path, { method: 'PATCH', headers: { ...CH, cookie }, body: JSON.stringify(body) });
}
function get(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}

async function setup(): Promise<{ app: Hono<AppEnv>; store: ConfigStore; admin: string; sari: string }> {
  const store = new MemoryStore();
  await seed(store); // sari=requester, budi=approver, putra=admin lead, lina=lead (NOT admin) — accounts.test seed
  const app = createApp(store);
  return { app, store, admin: await sessionCookieFor(store, 'putra'), sari: await sessionCookieFor(store, 'sari') };
}

/** A second, DISTINCT active admin — dual-control's ack requires one. */
async function addSecondAdmin(store: ConfigStore): Promise<void> {
  await seedAccount(store, { id: 'gita', role: 'lead', teamId: 'platform', isAdmin: true });
}

/** Mechanical, string-level proof that credential material never round-trips:
 * checks the WHOLE serialized body, not just a specific field, so a regression
 * that reintroduces the leak under a different key/shape still fails this. */
function assertNoCredentialLeak(value: unknown): void {
  const json = JSON.stringify(value);
  expect(json).not.toContain('argon2id');
  expect(json.toLowerCase()).not.toContain('"hash"');
  expect(json.toLowerCase()).not.toContain('credential');
  expect(json).not.toContain('"apply"');
}

describe('POST /admin/accounts — create/enrol account', () => {
  it('happy path: enrolling a requester into the current project applies immediately (201), never echoes the hash, and is audited', async () => {
    const { app, store, admin } = await setup();
    const res = await post(app, admin, '/admin/accounts', {
      username: 'nia',
      displayName: 'Nia',
      role: 'requester',
      teamId: 'app-platform',
      password: 'satu-dua-tiga-empat',
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ username: 'nia', displayName: 'Nia', role: 'requester', teamId: 'app-platform', status: 'active' });
    assertNoCredentialLeak(body);

    const stored = (await store.get(accountKey('nia').PK, 'META')) as AccountItem;
    expect(stored.credential.algo).toBe('argon2id');
    expect(stored.credential.hash).not.toBe('satu-dua-tiga-empat'); // never plaintext

    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    expect((exp.entries as ChainEntry[]).some((e) => e.action === 'account-enroll' && e.targetId === 'nia')).toBe(true);
  });

  it('enrolling a LEAD is dual-controlled (202); the pending body carries no credential/hash material anywhere', async () => {
    const { app, admin } = await setup();
    const res = await post(app, admin, '/admin/accounts', {
      username: 'zed',
      displayName: 'Zed',
      role: 'lead',
      teamId: 'platform',
      password: 'satu-dua-tiga-empat',
    });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('PENDING');
    expect(body).not.toHaveProperty('apply');
    assertNoCredentialLeak(body);
  });

  it('a second admin acking a senior enrol actually creates the account server-side, still with no leak in the ack response', async () => {
    const { app, store, admin } = await setup();
    await addSecondAdmin(store);
    const gita = await sessionCookieFor(store, 'gita');
    const pending = await (
      await post(app, admin, '/admin/accounts', { username: 'zed', displayName: 'Zed', role: 'lead', teamId: 'platform', password: 'satu-dua-tiga-empat' })
    ).json();
    const ack = await post(app, gita, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);
    assertNoCredentialLeak(await ack.json());
    const stored = (await store.get(accountKey('zed').PK, 'META')) as AccountItem;
    expect(roleFor(stored, 'sample')).toBe('lead'); // per-project role, resolved through the roles map
    expect(stored.credential.algo).toBe('argon2id');
  });

  it('a non-admin requester (sari) → 403 NOT_ADMIN', async () => {
    const { app, sari } = await setup();
    const res = await post(app, sari, '/admin/accounts', {
      username: 'blocked',
      displayName: 'Blocked',
      role: 'requester',
      teamId: 'app-platform',
      password: 'satu-dua-tiga-empat',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });

  it('a non-admin LEAD (lina) is ALSO refused — the gate is isAdmin, never role (ADR-0011)', async () => {
    const { app, store } = await setup();
    const lina = await sessionCookieFor(store, 'lina');
    const res = await post(app, lina, '/admin/accounts', {
      username: 'blocked2',
      displayName: 'Blocked2',
      role: 'requester',
      teamId: 'app-platform',
      password: 'satu-dua-tiga-empat',
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });
});

describe('PATCH /admin/accounts/:id — set-role', () => {
  it('happy path: promoting to lead is dual-controlled (202, §6 role dimension); a distinct 2nd admin ack applies it', async () => {
    const { app, store, admin } = await setup();
    await addSecondAdmin(store);
    const res = await patch(app, admin, '/admin/accounts/sari', { setRole: { projectId: 'sample', role: 'lead' } });
    expect(res.status).toBe(202);
    const pending = await res.json();
    expect(pending.status).toBe('PENDING');
    expect(pending).not.toHaveProperty('apply');

    const gita = await sessionCookieFor(store, 'gita');
    const ack = await post(app, gita, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);
    const acc = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(roleFor(acc, 'sample')).toBe('lead');
  });

  it('a non-admin requester (sari) → 403 NOT_ADMIN', async () => {
    const { app, sari } = await setup();
    const res = await patch(app, sari, '/admin/accounts/budi', { role: 'lead' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });

  it('privilege-escalation surface: a non-admin LEAD cannot promote anyone (incl. themselves to isAdmin) — 403 NOT_ADMIN', async () => {
    const { app, store } = await setup();
    const lina = await sessionCookieFor(store, 'lina');
    const res = await patch(app, lina, '/admin/accounts/sari', { role: 'lead' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
    const selfPromote = await patch(app, lina, '/admin/accounts/lina', { isAdmin: true });
    expect(selfPromote.status).toBe(403);
    expect((await selfPromote.json()).code).toBe('NOT_ADMIN');
  });
});

describe('PATCH /admin/accounts/:id — set-team', () => {
  it('happy path: moving a user to another team applies immediately (200) — team alone is not a privilege dimension', async () => {
    const { app, store, admin } = await setup();
    const res = await patch(app, admin, '/admin/accounts/sari', { setTeam: { projectId: 'sample', teamId: 'platform' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const acc = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(teamFor(acc, 'sample')).toBe('platform');
  });

  it('a non-admin requester (sari) → 403 NOT_ADMIN', async () => {
    const { app, sari } = await setup();
    const res = await patch(app, sari, '/admin/accounts/budi', { teamId: 'platform' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });
});

describe('PATCH /admin/accounts/:id — set-status', () => {
  it('happy path: disabling an account applies immediately (200, tightening)', async () => {
    const { app, store, admin } = await setup();
    const res = await patch(app, admin, '/admin/accounts/budi', { status: 'disabled' });
    expect(res.status).toBe(200);
    const acc = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    expect(acc.status).toBe('disabled');
  });

  it('re-enabling a disabled account is dual-controlled (202, loosening — restores access)', async () => {
    const { app, store, admin } = await setup();
    const budi = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    await store.put({ ...budi, status: 'disabled' });
    const res = await patch(app, admin, '/admin/accounts/budi', { status: 'active' });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('PENDING');
  });

  it('a non-admin requester (sari) → 403 NOT_ADMIN', async () => {
    const { app, sari } = await setup();
    const res = await patch(app, sari, '/admin/accounts/budi', { status: 'disabled' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });
});

describe('POST /admin/accounts/:id/reset-password', () => {
  it('happy path: resetting a REQUESTER password applies immediately (200), re-hashes argon2id, revokes sessions, and NEVER returns the hash', async () => {
    const { app, store, admin } = await setup();
    const before = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    const res = await post(app, admin, '/admin/accounts/sari/reset-password', { newPassword: 'baru-sekali-delapan' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
    assertNoCredentialLeak(body);

    const after = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(after.credential.algo).toBe('argon2id');
    expect(after.credential.hash).not.toBe(before.credential.hash);
    expect(after.credential.hash).not.toBe('baru-sekali-delapan'); // never plaintext
    expect(after.mustChangePassword).toBe(true);
    expect(after.sessionVersion).toBe(before.sessionVersion + 1); // kills live sessions
  });

  it('resetting an APPROVER password is dual-controlled (202, senior target); the pending body leaks no credential/hash material', async () => {
    const { app, admin } = await setup();
    const res = await post(app, admin, '/admin/accounts/budi/reset-password', { newPassword: 'baru-sekali-delapan' }); // budi=approver
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('PENDING');
    expect(body).not.toHaveProperty('apply');
    assertNoCredentialLeak(body);
  });

  it('the leak-check also covers GET /admin/config-changes (the pending item is listed there too)', async () => {
    const { app, admin } = await setup();
    await post(app, admin, '/admin/accounts/budi/reset-password', { newPassword: 'baru-sekali-delapan' });
    const list = await (await get(app, admin, '/admin/config-changes')).json();
    expect(Array.isArray(list) && list.length).toBeGreaterThan(0);
    assertNoCredentialLeak(list);
  });

  it('a second admin acking the reset applies the NEW password server-side, still with no leak in the ack response', async () => {
    const { app, store, admin } = await setup();
    await addSecondAdmin(store);
    const gita = await sessionCookieFor(store, 'gita');
    const before = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    const pending = await (
      await post(app, admin, '/admin/accounts/budi/reset-password', { newPassword: 'baru-sekali-delapan' })
    ).json();
    const ack = await post(app, gita, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);
    assertNoCredentialLeak(await ack.json());
    const after = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    expect(after.credential.hash).not.toBe(before.credential.hash);
    expect(after.mustChangePassword).toBe(true);
  });

  it('a non-admin requester (sari) → 403 NOT_ADMIN', async () => {
    const { app, sari } = await setup();
    const res = await post(app, sari, '/admin/accounts/budi/reset-password', { newPassword: 'baru-sekali-delapan' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });

  it('privilege-escalation surface: a non-admin LEAD cannot reset anyone’s password — 403 NOT_ADMIN', async () => {
    const { app, store } = await setup();
    const lina = await sessionCookieFor(store, 'lina');
    const res = await post(app, lina, '/admin/accounts/budi/reset-password', { newPassword: 'baru-sekali-delapan' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });
});

describe('PATCH /admin/accounts/:id — rename (displayName, a non-authorization field)', () => {
  it('happy path: renames immediately (200), audits before/after, and never bumps sessionVersion', async () => {
    const { app, store, admin } = await setup();
    const before = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    const res = await patch(app, admin, '/admin/accounts/sari', { displayName: 'Sari Wijaya' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const after = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(after.displayName).toBe('Sari Wijaya');
    expect(after.sessionVersion).toBe(before.sessionVersion); // not a capacity change
    expect(roleFor(after, 'sample')).toBe('requester'); // authorization untouched

    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    const entry = (exp.entries as ChainEntry[]).find((e) => e.action === 'account-rename' && e.targetId === 'sari');
    expect(entry).toBeTruthy();
    expect(entry?.before).toEqual({ displayName: 'Sari' });
    expect(entry?.after).toEqual({ displayName: 'Sari Wijaya' });
  });

  it('rejected when bundled with an authorization verb — rename is its own, whole request (422)', async () => {
    const { app, store, admin } = await setup();
    const res = await patch(app, admin, '/admin/accounts/sari', {
      displayName: 'Sari Wijaya',
      setRole: { projectId: 'sample', role: 'lead' },
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('VALIDATION_FAILED');
    const acc = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(acc.displayName).toBe('Sari'); // nothing applied
    expect(roleFor(acc, 'sample')).toBe('requester');
  });

  it('rejected when bundled with a global authorization field (status) — same one-change rule (422)', async () => {
    const { app, store, admin } = await setup();
    const res = await patch(app, admin, '/admin/accounts/sari', { displayName: 'Sari Wijaya', status: 'disabled' });
    expect(res.status).toBe(422);
    const acc = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(acc.displayName).toBe('Sari');
    expect(acc.status).toBe('active');
  });

  it('rejects an empty/whitespace-only name and a name over 80 characters (422)', async () => {
    const { app, admin } = await setup();
    for (const displayName of ['', '   ', 'x'.repeat(81)]) {
      const res = await patch(app, admin, '/admin/accounts/sari', { displayName });
      expect(res.status, JSON.stringify(displayName)).toBe(422);
    }
  });

  it('a non-admin requester (sari) → 403 NOT_ADMIN', async () => {
    const { app, sari } = await setup();
    const res = await patch(app, sari, '/admin/accounts/budi', { displayName: 'Budi Baru' });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });
});

describe('DELETE /admin/accounts/:id — permanent, fail-closed guarded', () => {
  function del(app: Hono<AppEnv>, cookie: string, id: string) {
    return app.request(`/admin/accounts/${id}`, { method: 'DELETE', headers: { ...CH, cookie } });
  }

  it('happy path: deletes a requester (200), removes the row, kills their live sessions, and audits it without credential material', async () => {
    const { app, store, admin } = await setup();
    const sariCookie = await sessionCookieFor(store, 'sari');
    expect((await get(app, sariCookie, '/auth/me')).status).toBe(200); // live before

    const res = await del(app, admin, 'sari');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, deleted: true });
    expect(body.sessionsRevoked).toBeGreaterThanOrEqual(1);
    assertNoCredentialLeak(body);

    expect(await store.get(accountKey('sari').PK, 'META')).toBeNull(); // the row is gone
    expect((await get(app, sariCookie, '/auth/me')).status).toBe(401); // the session is dead

    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    const entry = (exp.entries as ChainEntry[]).find((e) => e.action === 'account-delete' && e.targetId === 'sari');
    expect(entry).toBeTruthy();
    // The audited before-snapshot names what was removed (roles/status/isAdmin)
    // but NEVER credential material. (Chain entries legitimately carry their own
    // `hash`/`prevHash` linkage, so the whole-body leak matcher doesn't apply here.)
    const entryJson = JSON.stringify(entry);
    expect(entryJson).not.toContain('argon2id');
    expect(entryJson.toLowerCase()).not.toContain('credential');
    expect(entry?.before).toMatchObject({ status: 'active', isAdmin: false });
  });

  it('guard: deleting YOURSELF is refused (403 SELF_DELETE) — another admin must do it', async () => {
    const { app, store, admin } = await setup();
    const res = await del(app, admin, 'putra'); // putra deleting putra
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_DELETE');
    expect(await store.get(accountKey('putra').PK, 'META')).not.toBeNull();
  });

  it('guard: deleting the last active LEAD of a project is refused (422 LAST_LEAD_GUARD)', async () => {
    const { app, store, admin } = await setup();
    // ops: a second admin WITHOUT lead capacity, so putra can become the only active lead.
    await seedAccount(store, { id: 'ops', role: 'approver', teamId: 'platform', isAdmin: true });
    const ops = await sessionCookieFor(store, 'ops');
    // disable lina (the other sample lead) — putra still covers sample, so this is allowed…
    expect((await patch(app, admin, '/admin/accounts/lina', { status: 'disabled' })).status).toBe(200);
    // …and now deleting putra would strand sample with no active lead → refused.
    const res = await del(app, ops, 'putra');
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('LAST_LEAD_GUARD');
    expect(await store.get(accountKey('putra').PK, 'META')).not.toBeNull();
  });

  it('deleting a lead succeeds while ANOTHER active lead still covers the project', async () => {
    const { app, store, admin } = await setup();
    const res = await del(app, admin, 'lina'); // putra remains an active sample lead
    expect(res.status).toBe(200);
    expect(await store.get(accountKey('lina').PK, 'META')).toBeNull();
  });

  it('a non-admin requester (sari) → 403 NOT_ADMIN; an unknown id → 404', async () => {
    const { app, admin, sari } = await setup();
    const forbidden = await del(app, sari, 'budi');
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).code).toBe('NOT_ADMIN');
    expect((await del(app, admin, 'ghost')).status).toBe(404);
  });
});

describe('PATCH /admin/accounts/:id — G3 (proposal 0021 F3/G3): role/isAdmin grants bump sessionVersion', () => {
  it('promoting a requester to approver invalidates their live 1FA session once the ack lands', async () => {
    const { app, store, admin } = await setup();
    await addSecondAdmin(store);

    // sari (requester) already has a LIVE session — the exact F3 exploit shape: a
    // requester never needs TOTP, so this session never proved a second factor.
    const staleCookie = await sessionCookieFor(store, 'sari');
    expect((await get(app, staleCookie, '/auth/me')).status).toBe(200);

    const pending = await (await patch(app, admin, '/admin/accounts/sari', { setRole: { projectId: 'sample', role: 'approver' } })).json();
    expect(pending.status).toBe('PENDING');
    // not yet applied — the stale session still works until a distinct admin acks
    expect((await get(app, staleCookie, '/auth/me')).status).toBe(200);

    const before = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    const gita = await sessionCookieFor(store, 'gita');
    const ack = await post(app, gita, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);

    const acc = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(roleFor(acc, 'sample')).toBe('approver');
    expect(acc.sessionVersion).toBe(before.sessionVersion + 1);

    // the OLD (pre-grant) session cookie is now invalidated...
    const stale = await get(app, staleCookie, '/auth/me');
    expect(stale.status).toBe(401);
    expect((await stale.json()).code).toBe('SESSION_INVALIDATED');

    // ...forcing sari through login again — a FRESH session at the new version works.
    const freshCookie = await sessionCookieFor(store, 'sari');
    expect((await get(app, freshCookie, '/auth/me')).status).toBe(200);
  });

  it('an isAdmin grant ALSO bumps sessionVersion (not just role)', async () => {
    const { app, store, admin } = await setup();
    await addSecondAdmin(store);
    const staleCookie = await sessionCookieFor(store, 'lina'); // lead, not admin
    const before = (await store.get(accountKey('lina').PK, 'META')) as AccountItem;

    const pending = await (await patch(app, admin, '/admin/accounts/lina', { isAdmin: true })).json();
    const gita = await sessionCookieFor(store, 'gita');
    expect((await post(app, gita, `/admin/config-changes/${pending.id}/ack`)).status).toBe(200);

    const after = (await store.get(accountKey('lina').PK, 'META')) as AccountItem;
    expect(after.isAdmin).toBe(true);
    expect(after.sessionVersion).toBe(before.sessionVersion + 1);
    expect((await get(app, staleCookie, '/auth/me')).status).toBe(401);
  });

  it('a teamId/status-only PATCH does NOT bump sessionVersion (scoped to role/isAdmin only)', async () => {
    const { app, store, admin } = await setup();
    const before = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    const cookie = await sessionCookieFor(store, 'sari');

    expect((await patch(app, admin, '/admin/accounts/sari', { setTeam: { projectId: 'sample', teamId: 'platform' } })).status).toBe(200);
    const afterTeam = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(afterTeam.sessionVersion).toBe(before.sessionVersion);
    expect((await get(app, cookie, '/auth/me')).status).toBe(200); // still alive — unaffected

    expect((await patch(app, admin, '/admin/accounts/sari', { status: 'disabled' })).status).toBe(200);
    const afterStatus = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    // status alone kills sessions via the account-status re-read, not this version bump.
    expect(afterStatus.sessionVersion).toBe(before.sessionVersion);
  });

  it('account drift between propose and ack (an intervening password reset) rejects the ack STALE_PROPOSAL', async () => {
    const { app, store, admin } = await setup();
    await addSecondAdmin(store);
    const gita = await sessionCookieFor(store, 'gita');

    const pending = await (await patch(app, admin, '/admin/accounts/sari', { setRole: { projectId: 'sample', role: 'approver' } })).json();

    // sari is STILL role:'requester' in the store (unacked) → a password reset on her
    // classifies tightening and applies immediately, bumping accountVersion (the drift
    // guard every account apply carries) out from under the still-pending role-grant
    // proposal captured at an older version.
    const resetRes = await post(app, admin, '/admin/accounts/sari/reset-password', { newPassword: 'a-brand-new-pw-1' });
    expect(resetRes.status).toBe(200);

    const ack = await post(app, gita, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(409);
    expect((await ack.json()).code).toBe('STALE_PROPOSAL');

    // nothing was silently clobbered: sari is still a requester (the grant never applied).
    const acc = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    expect(roleFor(acc, 'sample')).toBe('requester');
  });
});
