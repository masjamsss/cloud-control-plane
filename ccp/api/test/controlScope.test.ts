import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import { accountKey, accountsGsi, projectCollectionGsi, type AccountItem, type ProjectItem } from '../src/store/schema';
import { CONTROL_SCOPE, __resetKnownProjectsForTests, isKnownProject, isValidProjectBinding } from '../src/projects';
import { sessionCookieFor } from './helpers/seed';

/**
 * data-birth spec §5 — the reserved control-plane scope `@control`. A blank
 * install has no baked estate id (DEFAULT_PROJECT='sample' is retired), so the
 * routing/audit/settings scope every header-less request resolves to, and the
 * scope chains/settings/teams route on when zero estates exist, is this
 * deliberately out-of-grammar id. This suite proves, independent of any estate:
 *
 *   - a header-less request resolves to `@control`, not an implicit estate;
 *   - `@control` is ALWAYS routable (no store row needed) — never listed by
 *     GET /projects, never a valid account binding, and fails the project-id
 *     grammar at register BY CONSTRUCTION (no special-casing needed);
 *   - membership on it holds ONLY via the `'*'` wildcard — a plain estate-bound
 *     account is simply not a member (403 PROJECT_SCOPE), distinct from a
 *     `'*'`-bound account that IS a member but still can't use it as an estate
 *     (403 CONTROL_SCOPE — a different refusal for a different reason);
 *   - estate-only surfaces (request submission/approval, catalog reads) refuse
 *     it explicitly.
 */

/** A lone account bound via the `'*'` wildcard (the founding-admin shape,
 * scripts/bootstrap.ts) — no seed()/settlement machinery needed, since this
 * shape is already canonical (arm 1: `roles` present). */
async function seedWildcardAdmin(store: ConfigStore, id = 'root'): Promise<void> {
  const item: AccountItem = {
    ...accountKey(id),
    id,
    username: id,
    displayName: id,
    roles: { '*': { role: 'lead' } },
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: true,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    totp: { secretEnc: 'enc', enrolledAt: '2026-07-11T00:00:00.000Z' },
    GSI1PK: accountsGsi(),
    GSI1SK: id,
  };
  await store.put(item);
}

/** A lone account bound ONLY to a specific ready project (never `'*'`) — the
 * modern, canonical shape (no legacy-shim dependency). */
async function seedEstateBoundAdmin(store: ConfigStore, id: string, projectId: string): Promise<void> {
  const item: AccountItem = {
    ...accountKey(id),
    id,
    username: id,
    displayName: id,
    roles: { [projectId]: { role: 'lead', teamId: 'platform' } },
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: true,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    totp: { secretEnc: 'enc', enrolledAt: '2026-07-11T00:00:00.000Z' },
    GSI1PK: accountsGsi(),
    GSI1SK: id,
  };
  await store.put(item);
}

/** Plant a ready ProjectItem row directly (no onboarding ladder needed — this
 * suite is about `@control`, not the ladder, which blankInstall.test.ts covers). */
async function plantReadyProject(store: ConfigStore, id: string): Promise<void> {
  const item: ProjectItem = {
    PK: `PROJECT#${id}`,
    SK: 'META',
    id,
    name: id,
    accountId: '123456789012',
    region: 'ap-southeast-5',
    status: 'ready',
    createdBy: 'test',
    createdAt: '2026-07-11T00:00:00.000Z',
    version: 1,
    GSI1PK: projectCollectionGsi(),
    GSI1SK: id,
  };
  await store.put(item as never);
}

const CH = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa' };

describe('controlScope — the reserved @control scope (data-birth spec §5)', () => {
  describe('header-less routing resolves to @control, not an implicit estate', () => {
    it('@control is always known (routable) even against a totally empty store', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      // A control-plane-safe surface (admin-global: the account directory) works
      // header-less — a header-less client is an inert CONTROL-PLANE client.
      const res = await app.request('/admin/accounts', { headers: { cookie: root } });
      expect(res.status).toBe(200);
    });

    it('the cache never manufactures an estate id — isKnownProject reflects only @control plus real store rows', () => {
      __resetKnownProjectsForTests();
      expect(isKnownProject(CONTROL_SCOPE)).toBe(true);
      expect(isKnownProject('sample')).toBe(false); // no baked default — nothing registered it
    });
  });

  describe('not listable, not bindable, not registrable (by construction)', () => {
    it('GET /projects never lists @control, even alongside a real ready estate', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      await plantReadyProject(store, 'acme');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      const res = await app.request('/projects', { headers: { cookie: root, 'x-ccp-project': 'acme' } });
      expect(res.status).toBe(200);
      const ids = ((await res.json()) as Array<{ id: string }>).map((p) => p.id);
      expect(ids).toEqual(['acme']);
      expect(ids).not.toContain(CONTROL_SCOPE);
    });

    it('isValidProjectBinding(@control) is false — the pure predicate every binding verb checks', () => {
      __resetKnownProjectsForTests();
      expect(isValidProjectBinding(CONTROL_SCOPE)).toBe(false);
      expect(isValidProjectBinding('*')).toBe(true); // the wildcard stays valid
    });

    it('live: enrolling an account explicitly bound to @control is refused 422 (not silently accepted)', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      const res = await app.request('/admin/accounts', {
        method: 'POST',
        headers: { ...CH, cookie: root }, // header-less acting scope: @control
        body: JSON.stringify({
          username: 'nia',
          displayName: 'Nia',
          role: 'requester',
          teamId: 'platform',
          password: 'satu-dua-tiga-empat',
          projectId: CONTROL_SCOPE,
        }),
      });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    });

    it('live: POST /projects with id "@control" fails the PROJECT_ID grammar at parse time — 422, no special-case needed', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      const res = await app.request('/projects', {
        method: 'POST',
        headers: { ...CH, cookie: root },
        body: JSON.stringify({
          id: CONTROL_SCOPE,
          name: 'Impossible estate',
          accountId: '123456789012',
          region: 'ap-southeast-5',
          github: { owner: 'x', repo: 'y' },
        }),
      });
      expect(res.status).toBe(422);
      expect((await res.json()).code).toBe('VALIDATION_FAILED');
    });
  });

  describe('membership on @control holds ONLY via the \'*\' wildcard', () => {
    it('an account bound only to a real estate (never \'*\') is NOT a member of @control — 403 PROJECT_SCOPE', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await plantReadyProject(store, 'acme');
      await seedEstateBoundAdmin(store, 'estatelead', 'acme');
      const app = createApp(store);
      const cookie = await sessionCookieFor(store, 'estatelead');

      // header-less → acting scope @control; this account has no '*' entry.
      const res = await app.request('/admin/accounts', { headers: { cookie } });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('PROJECT_SCOPE');

      // the SAME account acting on the estate it IS bound to works fine.
      const onEstate = await app.request('/admin/accounts', { headers: { cookie, 'x-ccp-project': 'acme' } });
      expect(onEstate.status).toBe(200);
    });

    it('a \'*\'-bound account IS a member of @control (passes the membership gate)', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      const res = await app.request('/admin/accounts', { headers: { cookie: root } });
      expect(res.status).toBe(200); // membership holds — @control's own refusal (below) is a DIFFERENT gate
    });
  });

  describe('estate-only surfaces refuse @control explicitly (403 CONTROL_SCOPE — distinct from PROJECT_SCOPE)', () => {
    it('request submission on @control is refused, even for a \'*\'-bound (member) account', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      const res = await app.request('/requests', {
        method: 'POST',
        headers: { ...CH, cookie: root }, // header-less → @control
        body: JSON.stringify({
          operationId: 'ebs-grow',
          targetAddress: 'aws_ebs_volume.x',
          params: { volume: 'aws_ebs_volume.x', new_size_gib: 100 },
          justification: 'this must never reach a handler — @control has no data plane',
          schedule: { kind: 'now' },
        }),
      });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('CONTROL_SCOPE');
    });

    it('request listing/read on @control is ALSO refused (the whole request surface, not just submit)', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      const res = await app.request('/requests?scope=all', { headers: { cookie: root } });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('CONTROL_SCOPE');
    });

    it('a catalog read (GET /admin/risk) on @control is refused — no per-project risk data on a non-project', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      const res = await app.request('/admin/risk', { headers: { cookie: root } });
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe('CONTROL_SCOPE');
    });

    it('admin-global surfaces (accounts, config-changes) and the projects registry are NOT estate-only — they work on @control', async () => {
      __resetKnownProjectsForTests();
      const store = new MemoryStore();
      await seedWildcardAdmin(store, 'root');
      const app = createApp(store);
      const root = await sessionCookieFor(store, 'root');

      expect((await app.request('/admin/accounts', { headers: { cookie: root } })).status).toBe(200);
      expect((await app.request('/admin/config-changes', { headers: { cookie: root } })).status).toBe(200);
      expect((await app.request('/projects', { headers: { cookie: root } })).status).toBe(200);
    });
  });
});
