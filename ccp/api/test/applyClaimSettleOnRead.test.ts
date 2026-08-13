import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';
import { digestOf, DryRunExecutor } from '../src/domain/apply/executor';
import { APPLY_LEASE_MS, APPLYING, HALTED_APPLY_FAILED, runDueApplies } from '../src/domain/apply/scheduler';

/**
 * CONC-10 — the last gap in the stuck-`APPLYING` story.
 *
 * API-2 gave the claim a lease (`applyClaimedAt` + {@link APPLY_LEASE_MS}), taught the
 * scheduler to halt an expired claim, and widened cancel to accept the halt statuses.
 * End to end that works — `schedulerStuckState.test.ts` pins it — but ONLY while the
 * scheduler is armed, because `runDueApplies` has exactly one production caller and it is
 * the `CCP_SCHEDULER=1` timer (`loop.ts`).
 *
 * That leaves an ordinary operator sequence wedged: arm the scheduler, have the process
 * die mid-apply (a crash, a container restart, a self-update), then DISARM the scheduler
 * while working out what landed — the obvious first move when an apply died halfway. No
 * tick will ever run again, and `APPLYING` is refused by approve, reject, rewindow,
 * cancel and the bundle alike. The row is back to "requires store surgery", which is
 * CONC-10's own words.
 *
 * The fix is the doctrine this codebase already uses for every other lease
 * (`settleCooling`, `settleWindow`, `settleScanJobLease`, `settlePendingExpiry`): settle
 * on read. The release now happens on the next READ or the next TICK, whichever comes
 * first, and both go through the same `halt()` — the last test here is what stops them
 * from drifting apart.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const CLAIMED_AT = Date.parse('2026-08-01T01:00:00.000Z');
const INSIDE_LEASE = CLAIMED_AT + 60_000;
const PAST_LEASE = CLAIMED_AT + APPLY_LEASE_MS + 60_000;
const AUDIT_PARTITION = '202608';

/** The exact shape a crashed worker leaves behind: claimed, stamped, never reported back. */
async function seedCrashedClaim(store: ConfigStore): Promise<string> {
  await seedRequests(store, PROJECT, 'sari', 1, {
    status: APPLYING,
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    targetAddress: 'aws_ebs_volume.dwh01',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-30T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-30T01:00:00.000Z' },
    ],
    schedule: WINDOW,
    planDigest: PINNED_DIGEST,
    pinnedDiff: PINNED_DIFF,
    applyClaimedAt: new Date(CLAIMED_AT).toISOString(),
    updatedAt: new Date(CLAIMED_AT).toISOString(),
  });
  return 'seed-sari-0';
}

async function getReq(store: ConfigStore, id: string): Promise<RequestItem> {
  const k = requestKey(PROJECT, id);
  const item = (await store.get(k.PK, k.SK)) as RequestItem | null;
  if (!item) throw new Error(`request ${id} not found`);
  return item;
}

async function auditActions(store: ConfigStore, id: string): Promise<string[]> {
  const entries = (await store.query(`P#${PROJECT}#AUDIT#${AUDIT_PARTITION}`)) as AuditItem[];
  return entries.filter((e) => e.requestId === id).map((e) => e.action);
}

async function get(app: Hono<AppEnv>, cookie: string, path: string): Promise<Response> {
  return app.request(path, { headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT } });
}

async function cancel(app: Hono<AppEnv>, cookie: string, id: string): Promise<Response> {
  return app.request(`/requests/${id}/cancel`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT },
  });
}

async function bootstrap(): Promise<{ store: MemoryStore; app: Hono<AppEnv>; cookie: string; id: string }> {
  const store = new MemoryStore();
  await seed(store);
  const app = createApp(store);
  const id = await seedCrashedClaim(store);
  const cookie = await sessionCookieFor(store, 'sari');
  return { store, app, cookie, id };
}

afterEach(() => __setNow(null));

describe('CONC-10 — an expired claim is released WITHOUT the scheduler ever running again', () => {
  it('a single GET releases the wedge, and cancel then works — no tick, no store surgery', async () => {
    const { store, app, cookie, id } = await bootstrap();
    __setNow(() => PAST_LEASE);

    // Setup assertion (L-1): the row really is wedged before the read. If the seed were
    // wrong (an unexpired stamp, a status that was never APPLYING) everything below
    // would pass for the wrong reason.
    expect((await getReq(store, id)).status).toBe(APPLYING);
    expect((await cancel(app, cookie, id)).status).toBe(409);

    // THE REGRESSION. Before the fix this GET returned APPLYING and changed nothing:
    // the ONLY code that could release the claim was `runDueApplies`, and its only
    // production caller is the CCP_SCHEDULER=1 timer, which a disarmed deployment does
    // not run. The row stayed APPLYING forever with every verb refusing it.
    const res = await get(app, cookie, `/requests/${id}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe(HALTED_APPLY_FAILED);

    // Released with the same evidence the tick would have written.
    const settled = await getReq(store, id);
    expect(settled.status).toBe(HALTED_APPLY_FAILED);
    expect(settled.events.at(-1)?.type).toBe('apply_failed');
    expect(await auditActions(store, id)).toEqual(['scheduler-apply-lease-expired']);

    // …and the halt has its exit: cancel accepts it (API-2).
    expect((await cancel(app, cookie, id)).status).toBe(200);
    expect((await getReq(store, id)).status).toBe('CANCELLED');
  });

  it('a LIVE claim is never robbed by a read — inside the lease the row is untouched', async () => {
    const { store, app, cookie, id } = await bootstrap();
    __setNow(() => INSIDE_LEASE);

    expect(((await (await get(app, cookie, `/requests/${id}`)).json()) as { status: string }).status).toBe(APPLYING);
    expect((await getReq(store, id)).status).toBe(APPLYING);
    expect(await auditActions(store, id)).toEqual([]);
    // And the API-5 invariant is untouched: a row a worker may still own is not cancellable.
    expect((await cancel(app, cookie, id)).status).toBe(409);
  });

  it('the LIST read settles it too — an operator who never opens the request still sees the truth', async () => {
    const { store, app, cookie, id } = await bootstrap();
    __setNow(() => PAST_LEASE);

    const res = await get(app, cookie, '/requests?scope=mine'); // sari's own queue
    const body = (await res.json()) as { items: Array<{ id: string; status: string }> };
    expect(body.items.find((x) => x.id === id)?.status).toBe(HALTED_APPLY_FAILED);
    expect((await getReq(store, id)).status).toBe(HALTED_APPLY_FAILED);
  });

  it('settling twice is a no-op — a second read writes no second halt', async () => {
    const { store, app, cookie, id } = await bootstrap();
    __setNow(() => PAST_LEASE);

    await get(app, cookie, `/requests/${id}`);
    await get(app, cookie, `/requests/${id}`);

    expect(await auditActions(store, id)).toEqual(['scheduler-apply-lease-expired']);
    expect((await getReq(store, id)).events.filter((e) => e.type === 'apply_failed')).toHaveLength(1);
  });
});

describe('CONC-10 — the read path and the tick path cannot drift apart', () => {
  it('a read settles a wedged claim to byte-identical state as a tick', async () => {
    // Two identical wedges: one released by the scheduler, one by an ordinary read.
    const byTick = await bootstrap();
    const byRead = await bootstrap();
    __setNow(() => PAST_LEASE);

    const outcomes = await runDueApplies(byTick.store, PROJECT, PAST_LEASE, new DryRunExecutor(), {});
    expect(outcomes).toEqual([{ requestId: byTick.id, result: 'halted', haltReason: 'APPLY_LEASE_EXPIRED' }]);

    await get(byRead.app, byRead.cookie, `/requests/${byRead.id}`);

    const a = await getReq(byTick.store, byTick.id);
    const b = await getReq(byRead.store, byRead.id);
    expect(b.status).toBe(a.status);
    expect(b.events.map((e) => ({ type: e.type, label: e.label, actor: e.actor }))).toEqual(
      a.events.map((e) => ({ type: e.type, label: e.label, actor: e.actor })),
    );
    expect(await auditActions(byRead.store, byRead.id)).toEqual(await auditActions(byTick.store, byTick.id));
  });
});
