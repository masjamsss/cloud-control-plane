import { describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import { accountKey, accountsGsi, yyyymm, type AccountItem, type AuditItem, type PendingConfigChangeItem } from '../src/store/schema';
import { classify, publicPendingChange, sweepExpired } from '../src/domain/dualControl';
import { __setKnownProjects, roleFor } from '../src/projects';
import { seed, sessionCookieFor } from './helpers/seed';

const P = { low: 1, medium: 1, high: 2, deleteMin: 2 };

async function addAdmin(store: ConfigStore, id: string): Promise<void> {
  await store.put({
    ...accountKey(id),
    id,
    username: id,
    displayName: id,
    role: 'lead',
    teamId: 'platform',
    status: 'active',
    createdAt: '2026-07-11T00:00:00.000Z',
    createdBy: 'system',
    mustChangePassword: false,
    isAdmin: true,
    credential: { algo: 'argon2id', hash: 'x' },
    failedAttempts: 0,
    sessionVersion: 1,
    GSI1PK: accountsGsi(),
    GSI1SK: id,
  } satisfies AccountItem);
}

// data-birth: a header-less request now acts on the reserved `@control` scope, not
// an implicit 'sample' (projects.ts CONTROL_SCOPE) — this suite always meant sample.
function put(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return app.request(path, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' }, body: JSON.stringify(body) });
}
function post(app: Hono<AppEnv>, cookie: string, path: string, body?: unknown) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' }, body: JSON.stringify(body ?? {}) });
}
function patch(app: Hono<AppEnv>, cookie: string, path: string, body: unknown) {
  return app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': 'sample' }, body: JSON.stringify(body) });
}
function get(app: Hono<AppEnv>, cookie: string, path: string) {
  return app.request(path, { headers: { cookie, 'x-ccp-project': 'sample' } });
}
async function auditActors(store: ConfigStore): Promise<string[]> {
  const items = (await store.query(`P#sample#AUDIT#${yyyymm(new Date())}`)) as AuditItem[];
  return items.map((i) => i.actor);
}

describe('§6 dual-control classification table', () => {
  it('classify matches the spec §6 table verbatim', () => {
    expect(classify({ target: 'policy', before: P, after: { ...P, high: 3 } })).toBe('tightening');
    expect(classify({ target: 'policy', before: P, after: { ...P, high: 1 } })).toBe('loosening');
    expect(classify({ target: 'risk', before: 'LOW', after: 'HIGH' })).toBe('tightening');
    expect(classify({ target: 'risk', before: 'HIGH', after: 'LOW' })).toBe('loosening');
    expect(classify({ target: 'catalog', enabledBefore: true, enabledAfter: false })).toBe('tightening');
    expect(classify({ target: 'catalog', enabledBefore: false, enabledAfter: true })).toBe('loosening');
    expect(classify({ target: 'freeze', before: false, after: true })).toBe('tightening');
    expect(classify({ target: 'freeze', before: true, after: false })).toBe('loosening');
    expect(classify({ target: 'role', before: 'requester', after: 'approver' })).toBe('loosening');
    expect(classify({ target: 'role', before: 'approver', after: 'requester' })).toBe('loosening');
    expect(classify({ target: 'admin', before: false, after: true })).toBe('loosening');
    expect(classify({ target: 'admin', before: true, after: false })).toBe('loosening');
    expect(classify({ target: 'password-reset', role: 'requester' })).toBe('tightening');
    expect(classify({ target: 'password-reset', role: 'lead' })).toBe('loosening');
    expect(classify({ target: 'enroll', role: 'requester', isAdmin: false })).toBe('tightening');
    expect(classify({ target: 'enroll', role: 'lead', isAdmin: false })).toBe('loosening');
    expect(classify({ target: 'enroll', role: 'requester', isAdmin: true })).toBe('loosening');
  });
});

describe('publicPendingChange — the client-safe projection (B1: never leak a stashed credential)', () => {
  it('strips `apply` and keeps every other field verbatim', () => {
    const item: PendingConfigChangeItem = {
      PK: 'P#sample#CONFIGCHANGE#01J',
      SK: 'META',
      id: '01J',
      kind: 'password-reset-senior',
      before: null,
      after: { mustChangePassword: true },
      targetKey: 'ACCOUNT#budi',
      apply: {
        op: 'update',
        pk: 'ACCOUNT#budi',
        sk: 'META',
        set: { credential: { algo: 'argon2id', hash: 'TOTALLY-SECRET-HASH' }, mustChangePassword: true },
      },
      proposedBy: 'putra',
      proposedAt: '2026-07-11T00:00:00.000Z',
      status: 'PENDING',
      expiresAt: '2026-07-14T00:00:00.000Z',
      GSI1PK: 'P#sample#CONFIGCHANGE#PENDING',
      GSI1SK: '01J',
    };
    const pub = publicPendingChange(item);
    expect(pub).not.toHaveProperty('apply');
    expect(JSON.stringify(pub)).not.toContain('TOTALLY-SECRET-HASH');
    expect(pub).toEqual({
      PK: item.PK,
      SK: item.SK,
      id: item.id,
      kind: item.kind,
      before: item.before,
      after: item.after,
      targetKey: item.targetKey,
      proposedBy: item.proposedBy,
      proposedAt: item.proposedAt,
      status: item.status,
      expiresAt: item.expiresAt,
      GSI1PK: item.GSI1PK,
      GSI1SK: item.GSI1SK,
    });
  });

  it('is a no-op on the fields it keeps when `apply` is already absent', () => {
    const item: PendingConfigChangeItem = {
      PK: 'x', SK: 'META', id: '01K', kind: 'policy-downgrade', before: 2, after: 1, targetKey: 'POLICY',
      proposedBy: 'putra', proposedAt: '2026-07-11T00:00:00.000Z', status: 'PENDING', expiresAt: '2026-07-14T00:00:00.000Z',
    };
    expect(publicPendingChange(item)).toEqual(item);
  });
});

describe('§6 dual-control acceptance (two seeded admins)', () => {
  async function setup() {
    const store = new MemoryStore();
    await seed(store);
    await addAdmin(store, 'gita'); // second admin (A=putra, B=gita)
    const app = createApp(store);
    return { store, app, A: await sessionCookieFor(store, 'putra'), B: await sessionCookieFor(store, 'gita') };
  }

  it('(a) admin A lowers high 2→1 → 202 PENDING; GET policy still returns 2', async () => {
    const { app, A } = await setup();
    const res = await put(app, A, '/admin/policy', { ...P, high: 1 });
    expect(res.status).toBe(202);
    const pending = await res.json();
    expect(pending.status).toBe('PENDING');
    expect((await (await get(app, A, '/admin/policy')).json()).high).toBe(2);
    expect((await (await get(app, A, '/admin/config-changes')).json())).toHaveLength(1);
  });

  it('(b) A acking their OWN proposal → 403 SELF_ACK', async () => {
    const { app, A } = await setup();
    const pending = await (await put(app, A, '/admin/policy', { ...P, high: 1 })).json();
    const res = await post(app, A, `/admin/config-changes/${pending.id}/ack`);
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('SELF_ACK');
  });

  it('(c) a DIFFERENT admin B acks → policy becomes 1, and the audit shows BOTH actors', async () => {
    const { store, app, A, B } = await setup();
    const pending = await (await put(app, A, '/admin/policy', { ...P, high: 1 })).json();
    const ack = await post(app, B, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);
    expect((await (await get(app, A, '/admin/policy')).json()).high).toBe(1);
    const actors = await auditActors(store);
    expect(actors).toContain('putra'); // proposer
    expect(actors).toContain('gita'); // acker
  });

  it('(d) a 73h-old pending item is swept to EXPIRED', async () => {
    const { store, app, A } = await setup();
    const pending = await (await put(app, A, '/admin/policy', { ...P, high: 1 })).json();
    const swept = await sweepExpired(store, 'sample', Date.parse(pending.proposedAt) + 73 * 60 * 60 * 1000);
    expect(swept).toBe(1);
    const list = await (await get(app, A, '/admin/config-changes')).json();
    // swept items leave the pending GSI, but the item's status is EXPIRED
    expect(list).toHaveLength(0);
  });

  it('(e) an open HIGH request keeps its 2-approval bar after the policy downgrade (tighten-only)', async () => {
    const { store, app, A, B } = await setup();
    const sari = await sessionCookieFor(store, 'sari');
    const lina = await sessionCookieFor(store, 'lina');

    // sari submits a HIGH Delete op → stamped approvalsRequired = 2. The op is
    // exposure:engineer_only, so it enters the ENGINEER track (server-enforced
    // since the 0014 dim-1 4.2 fix) and only a Lead's approval counts.
    const created = await (
      await app.request('/requests', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ccp-client': 'ccp-spa', cookie: sari, 'x-ccp-project': 'sample' },
        body: JSON.stringify({
          operationId: 'ebs-delete-volume',
          targetAddress: 'aws_ebs_volume.dwh01',
          params: { volume: 'aws_ebs_volume.dwh01' },
          justification: 'decommission the retired DWH01 data volume after migration',
          schedule: { kind: 'now' },
        }),
      })
    ).json();
    expect(created.approvalsRequired).toBe(2);
    expect(created.status).toBe('NEEDS_ENGINEER');

    // downgrade the whole policy to 1s via dual-control (A proposes, B acks)
    const pending = await (await put(app, A, '/admin/policy', { low: 1, medium: 1, high: 1, deleteMin: 1 })).json();
    expect((await post(app, B, `/admin/config-changes/${pending.id}/ack`)).status).toBe(200);
    expect((await (await get(app, A, '/admin/policy')).json()).high).toBe(1);

    // one Lead approval on the OPEN request must NOT complete it — the bar stays at the stamped 2
    const afterOne = await (
      await app.request(`/requests/${created.id}/approve`, { method: 'POST', headers: { 'x-ccp-client': 'ccp-spa', cookie: lina, 'x-ccp-project': 'sample' } })
    ).json();
    expect(afterOne.approvalsRequired).toBe(2);
    expect(afterOne.approvals).toHaveLength(1);
    expect(afterOne.status).toBe('NEEDS_ENGINEER');
  });

  it('(f) freeze ON applies immediately with a single admin', async () => {
    const { app, A } = await setup();
    const res = await put(app, A, '/admin/settings/freeze.global', { value: true });
    expect(res.status).toBe(200);
    const settings = await (await get(app, A, '/admin/settings')).json();
    expect(settings['freeze.global']).toBe(true);
    expect((await (await get(app, A, '/admin/config-changes')).json())).toHaveLength(0);
  });

  it('last-active-admin guard: revoking the only admin → 422 LAST_LEAD_GUARD', async () => {
    const store = new MemoryStore();
    await seed(store); // putra is the ONLY admin
    const app = createApp(store);
    const res = await patch(app, await sessionCookieFor(store, 'putra'), '/admin/accounts/putra', { isAdmin: false });
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe('LAST_LEAD_GUARD');
  });
});

describe('G4 (proposal 0021 F4): interimProfile flag + targetKey on senior-grant audit entries', () => {
  /** exactly ONE active senior (putra) + a second, NON-senior admin — isAdmin is
   * orthogonal to approval capacity (ADR-0011), so acks stay possible without a
   * second senior while `activeSeniors` (the interim signal) stays at 1. Unlike
   * seed(), this builds its accounts directly with no 'sample'-scoped team/policy/
   * audit footprint, so the legacy settlement (domain/settlement.ts) would have
   * nothing to organically retro-register 'sample' from — pin it known explicitly,
   * same as any other non-default-shaped test store. */
  async function thinBench(store: ConfigStore): Promise<void> {
    __setKnownProjects(['sample']);
    await addAdmin(store, 'putra'); // lead + admin
    await store.put({
      ...accountKey('ops2'),
      id: 'ops2',
      username: 'ops2',
      displayName: 'Ops2',
      role: 'requester',
      teamId: 'platform',
      status: 'active',
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: 'system',
      mustChangePassword: false,
      isAdmin: true,
      credential: { algo: 'argon2id', hash: 'x' },
      failedAttempts: 0,
      sessionVersion: 1,
      GSI1PK: accountsGsi(),
      GSI1SK: 'ops2',
    } satisfies AccountItem);
  }

  async function auditEntries(store: ConfigStore): Promise<AuditItem[]> {
    return (await store.query(`P#sample#AUDIT#${yyyymm(new Date())}`)) as AuditItem[];
  }

  it('enrolling a second approver while the bench is thin (1 active senior) flags interimProfile on config-propose', async () => {
    const store = new MemoryStore();
    await thinBench(store);
    const app = createApp(store);
    const putraCookie = await sessionCookieFor(store, 'putra');

    const res = await post(app, putraCookie, '/admin/accounts', {
      username: 'zed', displayName: 'Zed', role: 'approver', teamId: 'platform', password: 'satu-dua-tiga-empat',
    });
    expect(res.status).toBe(202);

    const propose = (await auditEntries(store)).find((e) => e.action === 'config-propose');
    expect(propose?.interimProfile).toBe(true);
  });

  it('...and acking it flags config-apply too, carrying targetKey (F4 second half)', async () => {
    const store = new MemoryStore();
    await thinBench(store);
    const app = createApp(store);
    const putraCookie = await sessionCookieFor(store, 'putra');
    const ops2Cookie = await sessionCookieFor(store, 'ops2');

    const pending = await (
      await post(app, putraCookie, '/admin/accounts', {
        username: 'zed', displayName: 'Zed', role: 'approver', teamId: 'platform', password: 'satu-dua-tiga-empat',
      })
    ).json();
    const ack = await post(app, ops2Cookie, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);

    const apply = (await auditEntries(store)).find((e) => e.action === 'config-apply');
    expect(apply?.interimProfile).toBe(true);
    expect((apply?.after as { targetKey?: string } | undefined)?.targetKey).toBe('ACCOUNT#zed');
  });

  it('once real quorum exists (≥2 active seniors) a NEW senior grant is NOT flagged interim, but targetKey is still carried', async () => {
    const store = new MemoryStore();
    await seed(store); // budi(approver) + putra(lead) + lina(lead) = 3 active seniors already
    await addAdmin(store, 'gita');
    const app = createApp(store);
    const putraCookie = await sessionCookieFor(store, 'putra');
    const gitaCookie = await sessionCookieFor(store, 'gita');

    const pending = await (
      await post(app, putraCookie, '/admin/accounts', {
        username: 'zed', displayName: 'Zed', role: 'approver', teamId: 'platform', password: 'satu-dua-tiga-empat',
      })
    ).json();
    expect(pending.status).toBe('PENDING');
    expect((await auditEntries(store)).find((e) => e.action === 'config-propose')?.interimProfile).toBeUndefined();

    const ack = await post(app, gitaCookie, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);
    const apply = (await auditEntries(store)).find((e) => e.action === 'config-apply');
    expect(apply?.interimProfile).toBeUndefined();
    expect((apply?.after as { targetKey?: string } | undefined)?.targetKey).toBe('ACCOUNT#zed'); // always carried
  });

  it('an isAdmin-only grant (role unchanged) is never flagged interim — isAdmin is orthogonal to approval capacity (ADR-0011)', async () => {
    const store = new MemoryStore();
    await thinBench(store);
    const app = createApp(store);
    const putraCookie = await sessionCookieFor(store, 'putra');
    const opsCookie = await sessionCookieFor(store, 'ops2');

    await store.put({
      ...accountKey('nia'),
      id: 'nia',
      username: 'nia',
      displayName: 'Nia',
      role: 'requester',
      teamId: 'platform',
      status: 'active',
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: 'system',
      mustChangePassword: false,
      isAdmin: false,
      credential: { algo: 'argon2id', hash: 'x' },
      failedAttempts: 0,
      sessionVersion: 1,
      GSI1PK: accountsGsi(),
      GSI1SK: 'nia',
    } satisfies AccountItem);

    const pending = await (await patch(app, putraCookie, '/admin/accounts/nia', { isAdmin: true })).json();
    expect(pending.status).toBe('PENDING');
    const ack = await post(app, opsCookie, `/admin/config-changes/${pending.id}/ack`);
    expect(ack.status).toBe(200);

    const apply = (await auditEntries(store)).find((e) => e.action === 'config-apply' && e.targetId === pending.id);
    expect(apply?.interimProfile).toBeUndefined();
  });

  it('a demotion (senior→requester) applies IMMEDIATELY (tightening) and is never flagged interim — it is not a "grant"', async () => {
    const store = new MemoryStore();
    await thinBench(store); // putra is the ONLY active senior
    await store.put({
      ...accountKey('yon'),
      id: 'yon',
      username: 'yon',
      displayName: 'Yon',
      role: 'approver',
      teamId: 'platform',
      status: 'active',
      createdAt: '2026-07-11T00:00:00.000Z',
      createdBy: 'system',
      mustChangePassword: false,
      isAdmin: false,
      credential: { algo: 'argon2id', hash: 'x' },
      failedAttempts: 0,
      sessionVersion: 1,
      GSI1PK: accountsGsi(),
      GSI1SK: 'yon',
    } satisfies AccountItem);
    const app = createApp(store);
    const putraCookie = await sessionCookieFor(store, 'putra');

    // Per-project model (0014): lowering to requester REDUCES capacity → tightening →
    // applies immediately with a single admin (no second-admin envelope), unlike the old
    // "any role touch is loosening" rule. Reducing privilege never waits on a co-signer.
    const res = await patch(app, putraCookie, '/admin/accounts/yon', { setRole: { projectId: 'sample', role: 'requester' } });
    expect(res.status).toBe(200);
    const yon = (await store.get(accountKey('yon').PK, 'META')) as AccountItem;
    expect(roleFor(yon, 'sample')).toBe('requester');

    // the immediate account-update audit entry never carries the interim flag (only
    // senior GRANTS through config-propose/apply do).
    const update = (await auditEntries(store)).find((e) => e.action === 'account-update' && e.targetId === 'yon');
    expect(update).toBeTruthy();
    expect(update?.interimProfile).toBeUndefined();
  });

  it('audit chain still verifies end to end with the new fields present', async () => {
    const store = new MemoryStore();
    await thinBench(store);
    const app = createApp(store);
    const putraCookie = await sessionCookieFor(store, 'putra');
    const ops2Cookie = await sessionCookieFor(store, 'ops2');
    const pending = await (
      await post(app, putraCookie, '/admin/accounts', {
        username: 'zed', displayName: 'Zed', role: 'approver', teamId: 'platform', password: 'satu-dua-tiga-empat',
      })
    ).json();
    await post(app, ops2Cookie, `/admin/config-changes/${pending.id}/ack`);

    const exp = await (await get(app, putraCookie, '/admin/audit/export')).json();
    expect(exp.verified).toBe(true);
  });
});
