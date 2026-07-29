import { describe, expect, it } from 'vitest';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { seed, seedRequests, sessionCookieFor, setSetting } from './helpers/seed';
import { isFrozenHold, settleFrozenHold } from '../src/domain/frozenHold';

/**
 * API-8 — a freeze-held `kind:'now'` request dead-ended in `AWAITING_DEPLOY_APPROVAL`
 * once the freeze lifted.
 *
 * At quorum-met the approve handler stamps `APPLIED` for a `kind:'now'` schedule, unless a
 * change freeze is on — no request may RECORD an apply during a freeze — in which case the
 * row is parked in `AWAITING_DEPLOY_APPROVAL` with a `held_frozen` event. Nothing ever
 * un-parked it. `settleWindow` returns immediately for `kind:'now'`, the scheduler's due
 * filter needs an open maintenance window (a `now` row has none), and the apply bundle is
 * disarmed by default. "Fully approved — held" was forever, with cancel as the only exit.
 *
 * What makes it a defect rather than a policy is the arbitrariness: the SAME request
 * approved one minute after the unfreeze is stamped `APPLIED` instantly. Its terminal fate
 * depended on which side of the freeze the last signature landed on.
 *
 * These tests drive the REAL routes, because the defect is that no route completes the
 * row — a unit test of the settler could not show that the seam is actually wired into
 * the paths a user's browser touches.
 */

const PROJECT = 'sample';

async function frozenHeldRow(store: ConfigStore, over: Partial<RequestItem> = {}): Promise<string> {
  await seedRequests(store, PROJECT, 'sari', 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    schedule: { kind: 'now' },
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-01T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-02T00:00:00.000Z' },
    ],
    events: [
      { at: '2026-07-02T00:00:00.000Z', type: 'held_frozen', label: 'Fully approved — held: a change freeze is on' },
    ],
    ...over,
  });
  return 'seed-sari-0';
}

const getReq = async (store: ConfigStore, id: string): Promise<RequestItem> => {
  const k = requestKey(PROJECT, id);
  return (await store.get(k.PK, k.SK)) as RequestItem;
};

const hdr = (cookie: string) => ({ 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT });

const getOne = (app: ReturnType<typeof createApp>, cookie: string, id: string) =>
  app.request(`/requests/${id}`, { headers: hdr(cookie) });

const list = (app: ReturnType<typeof createApp>, cookie: string) =>
  app.request('/requests?scope=mine', { headers: hdr(cookie) });

async function auditActions(store: ConfigStore, id: string): Promise<string[]> {
  const rows = (await store.query(`P#${PROJECT}#AUDIT#202607`)) as AuditItem[];
  const rows8 = (await store.query(`P#${PROJECT}#AUDIT#202608`)) as AuditItem[];
  return [...rows, ...rows8].filter((e) => e.requestId === id).map((e) => e.action);
}

describe('API-8 — the freeze-held `now` request completes once the freeze lifts', () => {
  it('THE DEFECT: reading it used to leave it held forever', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store); // no freeze setting → the freeze is OFF now
    const app = createApp(store);

    expect((await getReq(store, id)).status, 'the setup must really be a held row').toBe('AWAITING_DEPLOY_APPROVAL');

    const res = await getOne(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(200);
    expect((await res.json()).status, 'the read itself settles it — there is no background timer').toBe('APPLIED');
    expect((await getReq(store, id)).status).toBe('APPLIED');
  });

  it('stays held while the freeze is STILL on — the release is the unfreeze, not the read', async () => {
    const store = new MemoryStore();
    await seed(store);
    await setSetting(store, PROJECT, 'freeze.global', true);
    const id = await frozenHeldRow(store);
    const app = createApp(store);

    const res = await getOne(app, await sessionCookieFor(store, 'sari'), id);
    expect((await res.json()).status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('the LIST read settles it too — the queue is where a requester actually looks', async () => {
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store);
    const app = createApp(store);

    const res = await list(app, await sessionCookieFor(store, 'sari'));
    const body = (await res.json()) as { items: Array<{ id: string; status: string }> };
    expect(body.items.find((r) => r.id === id)!.status).toBe('APPLIED');
    expect((await getReq(store, id)).status).toBe('APPLIED');
  });

  it('records the release in the timeline and the audit chain, attributed to the unfreeze', async () => {
    // A status that changes with no actor and no entry is how an auditor loses the thread.
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store);
    const app = createApp(store);

    await getOne(app, await sessionCookieFor(store, 'sari'), id);

    const req = await getReq(store, id);
    expect(req.events.some((e) => e.type === 'applied' && /freeze lifted/i.test(e.label))).toBe(true);
    expect(await auditActions(store, id)).toContain('request-apply');
  });

  it('leaves a WINDOWED freeze-held row alone — the scheduler owns that one', async () => {
    // A windowed row parked by a freeze is not stranded: its window opens and the
    // scheduler picks it up. Sweeping it to APPLIED here would apply it OUTSIDE its
    // maintenance window, which is the opposite of the guarantee windows exist for.
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store, {
      schedule: { kind: 'window', at: '2030-01-01T00:00:00.000Z', endAt: '2030-01-01T04:00:00.000Z' },
    });
    const app = createApp(store);

    await getOne(app, await sessionCookieFor(store, 'sari'), id);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('leaves a `now` row with NO held_frozen marker alone', async () => {
    // The marker is the discriminator, not the status/schedule pair. A future branch that
    // parks a `now` row for some other reason must not be swept into APPLIED by this.
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store, { events: [{ at: '2026-07-02T00:00:00.000Z', type: 'scheduled', label: 'parked for some other reason' }] });
    const app = createApp(store);

    await getOne(app, await sessionCookieFor(store, 'sari'), id);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('FAIL-CLOSED: a row whose ladder was tightened past its signatures is NOT released', async () => {
    // The row met its quorum when it was approved. If the bar moved up while it sat
    // held, releasing it would stamp APPLIED on a change that no longer meets its own
    // quorum — so it stays held, which is a state a human can act on.
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store, {
      // An l2_blast_radius op needs the taller ladder; two signatures no longer suffice.
      exposure: 'l2_blast_radius',
      operationId: 'rds-instance-class',
      approvals: [{ user: 'budi', at: '2026-07-01T00:00:00.000Z' }],
    });
    const app = createApp(store);

    await getOne(app, await sessionCookieFor(store, 'sari'), id);
    expect((await getReq(store, id)).status, 'short of quorum → still held, never applied').toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('is idempotent and race-safe — concurrent settlers do not double-apply or throw', async () => {
    // Driven at the SETTLER, not through three concurrent HTTP reads. Three concurrent
    // authenticated requests against a cold store race the one-time legacy settlement and
    // two of them get a 409 from THAT (see API-20) — a pre-existing condition that has
    // nothing to do with this seam and would make a route-level race test measure the
    // wrong thing entirely. Here the contention is unambiguously between the settlers.
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store);
    const req = await getReq(store, id);

    const results = await Promise.all([
      settleFrozenHold(store, PROJECT, req, false),
      settleFrozenHold(store, PROJECT, req, false),
      settleFrozenHold(store, PROJECT, req, false),
    ]);

    for (const r of results) {
      expect(r.status, 'every caller sees the settled truth, none of them errors').toBe('APPLIED');
    }
    expect((await getReq(store, id)).status).toBe('APPLIED');
    // Exactly one release was recorded — not three.
    expect((await auditActions(store, id)).filter((x) => x === 'request-apply')).toHaveLength(1);
  });
});

describe('API-8 — isFrozenHold, the store-free screen', () => {
  it('is true only for AWAITING + kind:now + a held_frozen marker', () => {
    const base = {
      status: 'AWAITING_DEPLOY_APPROVAL',
      schedule: { kind: 'now' as const },
      events: [{ at: 'x', type: 'held_frozen', label: 'l' }],
    };
    expect(isFrozenHold(base)).toBe(true);
    expect(isFrozenHold({ ...base, status: 'APPLIED' })).toBe(false);
    expect(isFrozenHold({ ...base, schedule: { kind: 'window', at: 'x' } })).toBe(false);
    expect(isFrozenHold({ ...base, events: [] })).toBe(false);
  });

  it('settleFrozenHold is a no-op while frozen=true, without reading the store', async () => {
    // The list path resolves the freeze at most once per page and passes it in; a settler
    // that ignored the flag would defeat that and re-freeze-check per row.
    const store = new MemoryStore();
    await seed(store);
    const id = await frozenHeldRow(store);
    const req = await getReq(store, id);

    const unchanged = await settleFrozenHold(store, PROJECT, req, true);
    expect(unchanged.status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });
});
