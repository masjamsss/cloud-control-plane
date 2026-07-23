import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { requireAdmin } from '../src/middleware/authz';
import { accountKey, type AccountItem } from '../src/store/schema';
import { __setKnownProjects } from '../src/projects';
import { seed, seedAccount, seedRequests, sessionCookieFor, setPolicy, setSetting } from './helpers/seed';

const DRAFT = {
  operationId: 'ebs-grow',
  targetAddress: 'aws_ebs_volume.dwh01',
  params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 250 },
  justification: 'grow the volume to 250 GiB for month-end load',
  schedule: { kind: 'now' as const },
};

function appWithAdminStub(store: ConfigStore): Hono<AppEnv> {
  const app = createApp(store);
  app.get('/admin/stub', requireAdmin, (c) => c.json({ ok: true }));
  return app;
}

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE). This suite predates that concept
// and always meant "act on the sample estate" unless a call names a project.
function submit(app: Hono<AppEnv>, cookie: string, body: unknown, project?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': project ?? 'sample' };
  return app.request('/requests', { method: 'POST', headers, body: JSON.stringify(body) });
}
function approve(app: Hono<AppEnv>, cookie: string, id: string) {
  return app.request(`/requests/${id}/approve`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' } });
}
function get(app: Hono<AppEnv>, path: string, cookie: string, project?: string) {
  const headers: Record<string, string> = { cookie, 'x-ccp-project': project ?? 'sample' };
  return app.request(path, { headers });
}

afterEach(() => __setKnownProjects(['sample']));

describe('ADV-2 contract suite (spec §5)', () => {
  it('1. forged body identity is ignored — requester is always the session user', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), { ...DRAFT, requester: 'putra' });
    expect(res.status).toBe(201);
    expect((await res.json()).requester).toBe('sari');
  });

  it('2. approving your own request → 403 SELF_APPROVAL', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const budi = await sessionCookieFor(store, 'budi');
    const created = await (await submit(app, budi, DRAFT)).json(); // approvers may request
    const res = await approve(app, budi, created.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_APPROVAL');
  });

  it('3. the same approver approving twice → 409 ALREADY_APPROVED', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setPolicy(store, 'sample', { low: 1, medium: 2, high: 2, deleteMin: 2 }); // keep it open after 1 approval
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), DRAFT)).json();
    const budi = await sessionCookieFor(store, 'budi');
    expect((await approve(app, budi, created.id)).status).toBe(200);
    const second = await approve(app, budi, created.id);
    expect(second.status).toBe(409);
    expect((await second.json()).code).toBe('ALREADY_APPROVED');
  });

  it('4. a requester-role account calling approve → 403 FORBIDDEN_ROLE', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');
    const created = await (await submit(app, sari, DRAFT)).json();
    const res = await approve(app, sari, created.id);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('FORBIDDEN_ROLE');
  });

  it('5. a non-admin lead on /admin/* → 403 NOT_ADMIN (ADR-0011: lead != admin)', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = appWithAdminStub(store);
    const res = await get(app, '/admin/stub', await sessionCookieFor(store, 'lina')); // lina is lead, not admin
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('NOT_ADMIN');
  });

  it('6. submitting for a service outside your team → 403 TEAM_SCOPE', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    // sari is erp-basis; s3 belongs to platform
    const res = await submit(app, await sessionCookieFor(store, 'sari'), {
      ...DRAFT,
      operationId: 's3-update-tags',
      params: { tags: { CostCenter: 'X' } },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('TEAM_SCOPE');
  });

  it('7. submitting a disabled op → 422 OP_DISABLED', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'catalog.disabled-ops', ['ebs-grow']);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), DRAFT);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('OP_DISABLED');
  });

  it('8. policy medium=2 → a MEDIUM request stamps approvalsRequired 2 and one approval does not complete it', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setPolicy(store, 'sample', { low: 1, medium: 2, high: 2, deleteMin: 2 });
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), DRAFT)).json();
    expect(created.approvalsRequired).toBe(2);
    const afterOne = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    expect(afterOne.approvals).toHaveLength(1);
    expect(afterOne.status).toBe('AWAITING_CODE_REVIEW');
  });

  it('a param outside its manifest bounds → 422 PARAM_OUT_OF_BOUNDS', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), {
      ...DRAFT,
      params: { volume: 'aws_ebs_volume.dwh01', new_size_gib: 99999 }, // max is 16384
    });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('PARAM_OUT_OF_BOUNDS');
  });

  it('9. global freeze ON → submit 423 GLOBAL_FREEZE', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, 'sample', 'freeze.global', true);
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), DRAFT);
    expect(res.status).toBe(423);
    expect((await res.json()).code).toBe('GLOBAL_FREEZE');
  });

  it('10. the 51st submission in the hour → 429 RATE_LIMITED', async () => {
    const store = new MemoryStore();
    await seed(store);
    await seedRequests(store, 'sample', 'sari', 50); // 50 already this hour
    const app = createApp(store);
    const res = await submit(app, await sessionCookieFor(store, 'sari'), DRAFT);
    expect(res.status).toBe(429);
    expect((await res.json()).code).toBe('RATE_LIMITED');
    expect(res.headers.get('Retry-After')).toBeTruthy();
  });

  it('cross-project isolation: a request under sample is invisible under another project', async () => {
    __setKnownProjects(['sample', 'other']);
    const store = new MemoryStore();
    await seed(store);
    // Keying isolation needs an account AUTHORIZED for both projects, now that the
    // account↔project binding refuses unbound access outright (0014 dim-5 #1).
    await seedAccount(store, { id: 'roving', role: 'requester', teamId: 'erp-basis', isAdmin: false, projects: ['sample', 'other'] });
    const app = createApp(store);
    const sari = await sessionCookieFor(store, 'sari');
    const roving = await sessionCookieFor(store, 'roving');
    await submit(app, roving, DRAFT); // under default project sample

    // KEYING isolation: the sample request never leaks into the other project's collection.
    const underSample = await (await get(app, '/requests?scope=mine', roving)).json();
    const underOther = await (await get(app, '/requests?scope=mine', roving, 'other')).json();
    expect(underSample.items).toHaveLength(1);
    expect(underOther.items).toHaveLength(0);

    // AUTHZ isolation: sari carries no `projects` field → fail-closed default ['sample']
    // → reading another project is 403 PROJECT_SCOPE, not an empty 200 (the
    // pre-binding behavior this test used to assert).
    const denied = await get(app, '/requests?scope=mine', sari, 'other');
    expect(denied.status).toBe(403);
    expect((await denied.json()).code).toBe('PROJECT_SCOPE');

    // an unknown project id → 422
    __setKnownProjects(['sample']);
    const bad = await get(app, '/requests?scope=mine', sari, 'ghost');
    expect(bad.status).toBe(422);
  });

  it('no solo approval (0037): with only one eligible approver, a riskier change stalls at 1/2 — never a cooling completion', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setPolicy(store, 'sample', { low: 1, medium: 2, high: 2, deleteMin: 2 }); // policy no longer drives the count
    // leave only ONE eligible approver: disable putra and lina (no lead for the L3 step)
    for (const id of ['putra', 'lina']) {
      const k = accountKey(id);
      const acc = (await store.get(k.PK, k.SK)) as AccountItem;
      await store.put({ ...acc, status: 'disabled' });
    }
    const app = createApp(store);
    const created = await (await submit(app, await sessionCookieFor(store, 'sari'), DRAFT)).json();
    expect(created.approvalsRequired).toBe(2); // the [L2, L3] ladder
    const done = await (await approve(app, await sessionCookieFor(store, 'budi'), created.id)).json();
    // budi signs L2, but the change does NOT complete on one distinct signer — the
    // single-approver interim/cooling exception is gone.
    expect(done.approvals).toHaveLength(1);
    expect(done.status).toBe('AWAITING_CODE_REVIEW');
    expect(done.status).not.toBe('APPROVED_COOLING');
    expect(done.interimProfile).toBeUndefined();
    expect(done.earliestApplyAt).toBeUndefined();
    expect(done.nextApprovalStep).toBe('L3'); // still waiting for a lead that isn't there
  });
});
