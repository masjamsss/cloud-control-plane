import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem } from '../src/store/schema';
import { accountKey, type AccountItem } from '../src/store/schema';
import { __setKnownProjects, isBoundToProject, projectsOf, roleFor } from '../src/projects';
import { classify } from '../src/domain/dualControl';
import { seed, seedAccount, seedRequests, sessionCookieFor } from './helpers/seed';

/**
 * Account↔project authorization binding (0014 dim-5 finding #1, CRITICAL-latent):
 * before this suite's subject existed, ANY approver/lead could act on ANY project
 * by sending a different `x-ccp-project` header. Now every project-scoped
 * route (submit/list/read/approve/reject + /admin/*) requires the calling account
 * to be bound to the project; `['*']` = all projects; rows without the field
 * fail closed to ['sample'].
 */

const DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE). This suite predates that concept
// and always meant "act on the sample estate" unless a call names a project.
function hdrs(cookie: string, project?: string, json = false): Record<string, string> {
  const h: Record<string, string> = { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': project ?? 'sample' };
  if (json) h['content-type'] = 'application/json';
  return h;
}

async function setup(): Promise<{ store: ConfigStore; app: ReturnType<typeof createApp> }> {
  __setKnownProjects(['sample', 'bootstrap']);
  const store = new MemoryStore();
  await seed(store); // sari/budi/putra/lina — all WITHOUT a projects field (legacy shape)
  // an all-projects admin, and a second bootstrap-side request to act on
  await seedAccount(store, { id: 'root', role: 'lead', teamId: 'platform', isAdmin: true, projects: ['*'] });
  await seedRequests(store, 'bootstrap', 'ghazi', 1, { status: 'AWAITING_CODE_REVIEW' });
  return { store, app: createApp(store) };
}

afterEach(() => __setKnownProjects(['sample']));

describe('account↔project binding — pure helpers', () => {
  it('a bare row (absent roles AND projects) is a member of NOTHING — never all-projects, and no longer sample either (arm 3 retired, data-birth spec §5; real rows never reach here unmaterialized — domain/settlement.ts runs before every request)', () => {
    const legacy = {} as Pick<AccountItem, 'projects'>;
    expect(projectsOf(legacy)).toEqual([]);
    expect(isBoundToProject(legacy, 'sample')).toBe(false);
    expect(isBoundToProject(legacy, 'bootstrap')).toBe(false);
  });

  it("'*' binds to every project", () => {
    expect(isBoundToProject({ projects: ['*'] }, 'bootstrap')).toBe(true);
    expect(isBoundToProject({ projects: ['*'] }, 'sample')).toBe(true);
  });

  it('classify: widening the binding looses, narrowing tightens', () => {
    expect(classify({ target: 'projects', before: ['sample'], after: ['sample', 'bootstrap'] })).toBe('loosening');
    expect(classify({ target: 'projects', before: ['sample'], after: ['*'] })).toBe('loosening');
    expect(classify({ target: 'projects', before: ['sample', 'bootstrap'], after: ['sample'] })).toBe('tightening');
    expect(classify({ target: 'projects', before: ['*'], after: ['sample'] })).toBe('tightening');
    expect(classify({ target: 'projects', before: ['*'], after: ['*'] })).toBe('tightening');
  });
});

describe('account↔project binding — enforcement on every project-scoped route', () => {
  it('a lead scoped to [sample] gets 403 PROJECT_SCOPE on ALL of the bootstrap project: submit, list, read, approve, reject, admin', async () => {
    const { store, app } = await setup();
    const lina = await sessionCookieFor(store, 'lina'); // lead, legacy shape → ['sample']

    const submit = await app.request('/requests', {
      method: 'POST', headers: hdrs(lina, 'bootstrap', true), body: JSON.stringify(DRAFT),
    });
    expect(submit.status).toBe(403);
    expect((await submit.json()).code).toBe('PROJECT_SCOPE');

    const list = await app.request('/requests?scope=all', { headers: hdrs(lina, 'bootstrap') });
    expect(list.status).toBe(403);

    const read = await app.request('/requests/seed-ghazi-0', { headers: hdrs(lina, 'bootstrap') });
    expect(read.status).toBe(403);
    expect((await read.json()).code).toBe('PROJECT_SCOPE');

    const approve = await app.request('/requests/seed-ghazi-0/approve', { method: 'POST', headers: hdrs(lina, 'bootstrap') });
    expect(approve.status).toBe(403);
    expect((await approve.json()).code).toBe('PROJECT_SCOPE');

    const reject = await app.request('/requests/seed-ghazi-0/reject', {
      method: 'POST', headers: hdrs(lina, 'bootstrap', true), body: JSON.stringify({ reason: 'no' }),
    });
    expect(reject.status).toBe(403);

    // admin surface too: putra IS an admin but carries no binding → ['sample'] only
    const putra = await sessionCookieFor(store, 'putra');
    const adminRead = await app.request('/admin/policy', { headers: hdrs(putra, 'bootstrap') });
    expect(adminRead.status).toBe(403);
    expect((await adminRead.json()).code).toBe('PROJECT_SCOPE');

    // ...and the same lead keeps FULL access to the project they are bound to
    const home = await app.request('/requests?scope=all', { headers: hdrs(lina) });
    expect(home.status).toBe(200);
  });

  it('an all-projects admin succeeds on the bootstrap project (read, admin, approve)', async () => {
    const { store, app } = await setup();
    const root = await sessionCookieFor(store, 'root');

    expect((await app.request('/requests?scope=all', { headers: hdrs(root, 'bootstrap') })).status).toBe(200);
    expect((await app.request('/admin/policy', { headers: hdrs(root, 'bootstrap') })).status).toBe(200);

    const read = await app.request('/requests/seed-ghazi-0', { headers: hdrs(root, 'bootstrap') });
    expect(read.status).toBe(200);
    expect((await read.json()).id).toBe('seed-ghazi-0');
  });

  it('the denial is appended to the TARGET project audit chain (actor, route, binding)', async () => {
    const { store, app } = await setup();
    const lina = await sessionCookieFor(store, 'lina');
    await app.request('/requests?scope=mine', { headers: hdrs(lina, 'bootstrap') });

    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const entries = (await store.query(`P#bootstrap#AUDIT#${yyyymm}`)) as AuditItem[];
    const denial = entries.find((e) => e.action === 'project-scope-denied');
    expect(denial).toBeTruthy();
    expect(denial!.actor).toBe('lina');
    expect(denial!.targetId).toBe('bootstrap');
    expect((denial!.after as { boundTo: string[] }).boundTo).toEqual(['sample']);
  });

  it('unauthenticated callers never reach the membership gate (401 first, no denial audit)', async () => {
    const { store, app } = await setup();
    const res = await app.request('/requests?scope=mine', { headers: { 'x-ccp-project': 'bootstrap' } });
    expect(res.status).toBe(401);
    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const entries = (await store.query(`P#bootstrap#AUDIT#${yyyymm}`)) as AuditItem[];
    expect(entries.find((e) => e.action === 'project-scope-denied')).toBeUndefined();
  });
});

describe('account↔project binding — admin-managed + audited', () => {
  it('granting a per-project role is dual-controlled: propose (202) → distinct admin ack → the account gains the project', async () => {
    const { store, app } = await setup();
    const root = await sessionCookieFor(store, 'root');
    const putra = await sessionCookieFor(store, 'putra');
    const lina = await sessionCookieFor(store, 'lina');

    // before: lina is refused on bootstrap
    expect((await app.request('/requests?scope=mine', { headers: hdrs(lina, 'bootstrap') })).status).toBe(403);

    // root proposes granting lina LEAD on bootstrap → new senior capacity → loosening → 202 pending
    const patch = await app.request('/admin/accounts/lina', {
      method: 'PATCH', headers: hdrs(root, undefined, true),
      body: JSON.stringify({ setRole: { projectId: 'bootstrap', role: 'lead', teamId: 'platform' } }),
    });
    expect(patch.status).toBe(202);
    const pending = await patch.json();
    expect(pending.status).toBe('PENDING');

    // lina still refused while the grant is pending
    expect((await app.request('/requests?scope=mine', { headers: hdrs(lina, 'bootstrap') })).status).toBe(403);

    // a second, distinct admin acks → applied
    const ack = await app.request(`/admin/config-changes/${pending.id}/ack`, { method: 'POST', headers: hdrs(putra) });
    expect(ack.status).toBe(200);

    // now lina can act on bootstrap, and is a lead THERE (per-project) while still a lead on sample
    expect((await app.request('/requests?scope=mine', { headers: hdrs(lina, 'bootstrap') })).status).toBe(200);
    const linaAcc = (await store.get(accountKey('lina').PK, 'META')) as AccountItem;
    expect(roleFor(linaAcc, 'bootstrap')).toBe('lead');
    expect(roleFor(linaAcc, 'sample')).toBe('lead');

    // and the grant is in the audit chain: the dual-control pair (propose by root,
    // apply by putra) carrying the per-project {projectId, role} delta
    const yyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
    const entries = (await store.query(`P#sample#AUDIT#${yyyymm}`)) as AuditItem[];
    const propose = entries.find(
      (e) => e.action === 'config-propose' && (e.after as { targetKey?: string }).targetKey === 'ACCOUNT#lina',
    );
    expect(propose).toBeTruthy();
    expect(propose!.actor).toBe('root');
    const applied = entries.find((e) => e.action === 'config-apply' && e.targetId === pending.id);
    expect(applied).toBeTruthy();
    expect(applied!.actor).toBe('putra');
    const after = (applied!.after as { after: { projectId: string; role: string; roles: Record<string, unknown> } }).after;
    expect(after.projectId).toBe('bootstrap');
    expect(after.role).toBe('lead');
    expect(Object.keys(after.roles).sort()).toEqual(['bootstrap', 'sample']);
    // before-image records the account's prior membership set
    expect((applied!.before as { before: { projects: string[] } }).before.projects).toEqual(['sample']);
  });

  it('revoking a per-project binding tightens: applies immediately (200) and locks the account out', async () => {
    const { store, app } = await setup();
    const root = await sessionCookieFor(store, 'root');
    await seedAccount(store, { id: 'wide', role: 'approver', teamId: 'app-platform', isAdmin: false, projects: ['sample', 'bootstrap'] });
    const wide = await sessionCookieFor(store, 'wide');
    expect((await app.request('/requests?scope=mine', { headers: hdrs(wide, 'bootstrap') })).status).toBe(200);

    const patch = await app.request('/admin/accounts/wide', {
      method: 'PATCH', headers: hdrs(root, undefined, true), body: JSON.stringify({ revoke: { projectId: 'bootstrap' } }),
    });
    expect(patch.status).toBe(200);
    expect((await app.request('/requests?scope=mine', { headers: hdrs(wide, 'bootstrap') })).status).toBe(403);
    // still bound to sample (the revoke was surgical, one project)
    expect((await app.request('/requests?scope=mine', { headers: hdrs(wide) })).status).toBe(200);
  });

  it('verb projectId must be a registered project → 422; the wildcard is refused as a verb target', async () => {
    const { store, app } = await setup();
    const root = await sessionCookieFor(store, 'root');
    const ghost = await app.request('/admin/accounts/lina', {
      method: 'PATCH', headers: hdrs(root, undefined, true), body: JSON.stringify({ setRole: { projectId: 'ghost', role: 'approver' } }),
    });
    expect(ghost.status).toBe(422);
    // '*' is bootstrap/migration-only — never a verb target
    const star = await app.request('/admin/accounts/lina', {
      method: 'PATCH', headers: hdrs(root, undefined, true), body: JSON.stringify({ setRole: { projectId: '*', role: 'approver' } }),
    });
    expect(star.status).toBe(422);
    // a whole-map replacement (legacy shape) is stripped to nothing → 422 (no mass assignment)
    const wholeMap = await app.request('/admin/accounts/lina', {
      method: 'PATCH', headers: hdrs(root, undefined, true), body: JSON.stringify({ roles: { bootstrap: { role: 'lead' } } }),
    });
    expect(wholeMap.status).toBe(422);
  });

  it('enroll defaults the binding to the enrolling project and reports it in the projection', async () => {
    const { store, app } = await setup();
    const putra = await sessionCookieFor(store, 'putra');
    const res = await app.request('/admin/accounts', {
      method: 'POST', headers: hdrs(putra, undefined, true),
      body: JSON.stringify({ username: 'nia', displayName: 'Nia', role: 'requester', teamId: 'app-platform', password: 'satu-dua-tiga-empat' }),
    });
    expect(res.status).toBe(201);
    expect((await res.json()).projects).toEqual(['sample']);

    const k = accountKey('nia');
    const acc = (await store.get(k.PK, k.SK)) as AccountItem;
    expect(projectsOf(acc)).toEqual(['sample']); // resolved from the new roles map
    expect(acc.roles).toEqual({ sample: { role: 'requester', teamId: 'app-platform' } });
  });

  it('enrolling straight into ANOTHER project is a cross-tenant grant → dual-controlled (202), even for a requester', async () => {
    const { store, app } = await setup();
    const root = await sessionCookieFor(store, 'root');
    const res = await app.request('/admin/accounts', {
      method: 'POST', headers: hdrs(root, undefined, true),
      body: JSON.stringify({ username: 'omni', displayName: 'Omni', role: 'requester', teamId: 'app-platform', password: 'satu-dua-tiga-empat', projectId: 'bootstrap' }),
    });
    expect(res.status).toBe(202);
    expect((await res.json()).status).toBe('PENDING');
  });

  it('enrolling into the wildcard is refused — the all-projects binding is bootstrap/migration-only (422)', async () => {
    const { store, app } = await setup();
    const root = await sessionCookieFor(store, 'root');
    const res = await app.request('/admin/accounts', {
      method: 'POST', headers: hdrs(root, undefined, true),
      body: JSON.stringify({ username: 'omni', displayName: 'Omni', role: 'requester', teamId: 'app-platform', password: 'satu-dua-tiga-empat', projectId: '*' }),
    });
    expect(res.status).toBe(422);
  });
});
