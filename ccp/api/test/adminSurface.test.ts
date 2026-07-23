import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, teamKey, type AccountItem, type TeamItem } from '../src/store/schema';
import { verifyChain, type ChainEntry } from '../src/domain/audit';
import { mintSession } from '../src/auth/sessions';
import { seed, sessionCookieFor } from './helpers/seed';

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — see accountsAdmin.test.ts's
// identical note.
const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', 'x-ccp-project': 'sample' };

function post(app: Hono<AppEnv>, cookie: string, path: string, body?: unknown) {
  return app.request(path, { method: 'POST', headers: { ...CH, cookie }, body: JSON.stringify(body ?? {}) });
}
function put(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return app.request(path, { method: 'PUT', headers: { ...CH, cookie }, body: JSON.stringify(body) });
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

async function setup(): Promise<{ app: Hono<AppEnv>; store: ConfigStore; admin: string; sari: string }> {
  const store = new MemoryStore();
  await seed(store); // putra=admin lead, sari=requester, budi=approver, lina=lead; teams from project.json
  const app = createApp(store);
  return { app, store, admin: await sessionCookieFor(store, 'putra'), sari: await sessionCookieFor(store, 'sari') };
}

describe('Task 3 · teams CRUD (was OpenAPI-declared but unrouted → 404)', () => {
  it('creates a team with a slugified id and lists it', async () => {
    const { app, admin } = await setup();
    const res = await post(app, admin, '/admin/teams', { name: 'App Gateway' });
    expect(res.status).toBe(201);
    expect((await res.json()).id).toBe('app-gateway');

    const list = await get(app, admin, '/admin/teams');
    expect(list.status).toBe(200);
    const names = ((await list.json()) as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain('App Gateway');
    expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b))); // name-sorted
  });

  it('rejects a too-short name (422) and a duplicate name (409 DUPLICATE_TEAM)', async () => {
    const { app, admin } = await setup();
    expect((await post(app, admin, '/admin/teams', { name: 'x' })).status).toBe(422);
    await post(app, admin, '/admin/teams', { name: 'Payments' });
    const dup = await post(app, admin, '/admin/teams', { name: 'payments' }); // case-insensitive
    expect(dup.status).toBe(409);
    expect((await dup.json()).code).toBe('DUPLICATE_TEAM');
  });

  it('renames a team and blocks a colliding rename', async () => {
    const { app, admin } = await setup();
    await post(app, admin, '/admin/teams', { name: 'Alpha' });
    const beta = await post(app, admin, '/admin/teams', { name: 'Beta' });
    const betaId = (await beta.json()).id as string;
    expect((await patch(app, admin, `/admin/teams/${betaId}`, { name: 'Beta Prime' })).status).toBe(200);
    expect((await patch(app, admin, `/admin/teams/${betaId}`, { name: 'Alpha' })).status).toBe(409);
    expect((await patch(app, admin, '/admin/teams/nonexistent', { name: 'Zed' })).status).toBe(404);
  });

  it('set-services enforces single ownership — a service is STOLEN from its prior owner', async () => {
    const { app, admin, store } = await setup();
    const a = (await (await post(app, admin, '/admin/teams', { name: 'Owner A', serviceSlugs: ['shared-svc'] })).json()).id as string;
    const b = (await (await post(app, admin, '/admin/teams', { name: 'Owner B' })).json()).id as string;

    const res = await put(app, admin, `/admin/teams/${b}/services`, { serviceSlugs: ['shared-svc'] });
    expect(res.status).toBe(200);
    expect((await res.json()).serviceSlugs).toEqual(['shared-svc']);

    const aItem = (await store.get(teamKey('sample', a).PK, 'META')) as TeamItem;
    expect(aItem.serviceSlugs).not.toContain('shared-svc'); // stolen away
    const bItem = (await store.get(teamKey('sample', b).PK, 'META')) as TeamItem;
    expect(bItem.serviceSlugs).toContain('shared-svc');
  });

  it('delete is refused while the team has services or members, then succeeds when empty', async () => {
    const { app, admin, store } = await setup();
    const id = (await (await post(app, admin, '/admin/teams', { name: 'Doomed', serviceSlugs: ['temp-svc'] })).json()).id as string;
    expect((await del(app, admin, `/admin/teams/${id}`)).status).toBe(409); // has a service

    await put(app, admin, `/admin/teams/${id}/services`, { serviceSlugs: [] }); // drop services
    // now give it a member. Canonical `roles` shape (not the bare legacy scalar
    // trio) — this row is written directly to the store, after this same store's
    // one-time settlement has already run (the `post`/`del` calls above), so a
    // bare-shape row here would never get materialized and would silently NOT
    // count as a team member (rolesOf's retired arm 3 is `{}`, data-birth spec §5).
    await store.put({ ...accountKey('member1'), id: 'member1', username: 'member1', displayName: 'M', roles: { sample: { role: 'requester', teamId: id } }, status: 'active', createdAt: 'x', createdBy: 'system', mustChangePassword: false, isAdmin: false, credential: { algo: 'argon2id', hash: 'x' }, failedAttempts: 0, sessionVersion: 1, GSI1PK: 'ACCOUNTS', GSI1SK: 'member1' } satisfies AccountItem);
    expect((await del(app, admin, `/admin/teams/${id}`)).status).toBe(409); // has a member

    await store.delete(accountKey('member1').PK, 'META');
    expect((await del(app, admin, `/admin/teams/${id}`)).status).toBe(204); // empty → deleted
    expect(await store.get(teamKey('sample', id).PK, 'META')).toBeNull();
  });
});

describe('Task 3 · audit is readable, exportable, and chain-verifiable', () => {
  it('GET /admin/audit returns newest-first hash-chained entries; export self-verifies', async () => {
    const { app, admin } = await setup();
    // generate several audited admin actions
    await post(app, admin, '/admin/teams', { name: 'One' });
    await post(app, admin, '/admin/teams', { name: 'Two' });
    await post(app, admin, '/admin/teams', { name: 'Three' });

    const list = await get(app, admin, '/admin/audit');
    expect(list.status).toBe(200);
    const items = (await list.json()).items as ChainEntry[];
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]!.at >= items[1]!.at).toBe(true); // newest-first
    expect(items.every((e) => typeof e.hash === 'string' && typeof e.prevHash === 'string')).toBe(true);

    const exp = await get(app, admin, '/admin/audit/export');
    expect(exp.headers.get('content-disposition')).toContain('attachment');
    const doc = (await exp.json()) as { verified: boolean; count: number; head: string; entries: ChainEntry[] };
    expect(doc.verified).toBe(true);
    expect(doc.entries.length).toBe(doc.count);
    // independently re-verify the exported chain against the head
    expect(verifyChain(doc.entries, { head: doc.head }).code).toBe(0);
  });

  it('audit endpoints require admin (403 for a requester)', async () => {
    const { app, sari } = await setup();
    expect((await get(app, sari, '/admin/audit')).status).toBe(403);
    expect((await get(app, sari, '/admin/audit/export')).status).toBe(403);
  });

  it('pagination cursor walks the chain without overlap', async () => {
    const { app, admin } = await setup();
    for (let i = 0; i < 5; i++) await post(app, admin, '/admin/teams', { name: `T${i}` });
    const p1 = await (await get(app, admin, '/admin/audit?limit=2')).json();
    expect(p1.items.length).toBe(2);
    expect(p1.cursor).toBeTruthy();
    const p2 = await (await get(app, admin, `/admin/audit?limit=2&cursor=${p1.cursor}`)).json();
    const ids1 = new Set((p1.items as ChainEntry[]).map((e) => e.id));
    expect((p2.items as ChainEntry[]).some((e) => ids1.has(e.id))).toBe(false); // no overlap
  });
});

describe('Task 3 · TOTP reset (fixes lost-phone privileged lockout)', () => {
  it('clears the enrolled factor, kills sessions, and audits it', async () => {
    const { app, store, admin } = await setup();
    // enrol a TOTP factor on budi + give budi a live session
    const budi = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    await store.put({ ...budi, totp: { secretEnc: 'enc', enrolledAt: '2026-07-11T00:00:00.000Z' } });
    const budiCookie = await sessionCookieFor(store, 'budi');
    expect((await get(app, budiCookie, '/auth/me')).status).toBe(200); // session works before reset

    const res = await post(app, admin, '/admin/accounts/budi/reset-totp');
    expect(res.status).toBe(200);
    expect((await res.json()).totpReset).toBe(true);

    const after = (await store.get(accountKey('budi').PK, 'META')) as AccountItem;
    expect(after.totp).toBeUndefined(); // factor cleared → re-enroll on next login
    expect(after.sessionVersion).toBe(budi.sessionVersion + 1);
    expect((await get(app, budiCookie, '/auth/me')).status).toBe(401); // old session revoked

    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    expect((exp.entries as ChainEntry[]).some((e) => e.action === 'totp-reset' && e.targetId === 'budi')).toBe(true);
  });

  it('reset-totp requires admin (403 for a requester) and 404s an unknown account', async () => {
    const { app, admin, sari } = await setup();
    expect((await post(app, sari, '/admin/accounts/budi/reset-totp')).status).toBe(403);
    expect((await post(app, admin, '/admin/accounts/ghost/reset-totp')).status).toBe(404);
  });
});

describe('Task 3 · session revocation wires killAllSessions (was dead code)', () => {
  it('revokes every live session for a user and audits it', async () => {
    const { app, store, admin } = await setup();
    const sari = (await store.get(accountKey('sari').PK, 'META')) as AccountItem;
    const t1 = await mintSession(store, 'sari', sari.sessionVersion);
    const t2 = await mintSession(store, 'sari', sari.sessionVersion);

    const res = await post(app, admin, '/admin/accounts/sari/revoke-sessions');
    expect(res.status).toBe(200);
    expect((await res.json()).sessionsRevoked).toBeGreaterThanOrEqual(2); // t1 + t2 (+ the setup session)

    for (const t of [t1, t2]) expect((await get(app, `ccp_session=${t}`, '/auth/me')).status).toBe(401);
    const exp = await (await get(app, admin, '/admin/audit/export')).json();
    expect((exp.entries as ChainEntry[]).some((e) => e.action === 'sessions-revoke' && e.targetId === 'sari')).toBe(true);
  });
});
