import { afterEach, describe, expect, it } from 'vitest';
import type { Hono } from 'hono';
import { createApp } from '../src/index';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AppEnv } from '../src/appEnv';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seed, seedRequests, sessionCookieFor } from './helpers/seed';
import { digestOf, DryRunExecutor, type ApplyExecutor } from '../src/domain/apply/executor';
import { HALTED_DRIFT, HELD_NO_PLAN_EVENT, pinStateOf, runDueApplies } from '../src/domain/apply/scheduler';
import type { Notifier, SchedulerNotification } from '../src/domain/apply/notify';

/**
 * API-3 — arming the scheduler used to HALT every scheduled request, because
 * `processOne` refuses anything without an intact plan pin and NOTHING in the product
 * ever writes one. The schema says the pin is "written at approval time by a LATER step";
 * that step does not exist, and a repo-wide search finds only test helpers and a proof
 * script writing `pinnedDiff`/`planDigest`.
 *
 * So the first tick after any approved window opened moved the request
 * `AWAITING_DEPLOY_APPROVAL → HALTED_DRIFT` — and per API-2 nothing could move it back.
 * Setting the documented `CCP_SCHEDULER=1` did not skip the auto-apply feature, it
 * DESTROYED every request that reached its window.
 *
 * The fix separates "no pin was ever written" (a deployment without a pin-writer → HOLD)
 * from "a pin exists and does not hold up" (tamper/damage → HALT). This file pins both
 * halves, plus the two properties a hold has to have to be an improvement rather than a
 * silent skip: the request stays usable, and the reason is recorded once.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z'); // inside [00:00, 04:00)
const AUDIT_PARTITION = '202608';

/** A due, fully-approved, windowed request — with NO pin, which is every real request today. */
async function seedUnpinned(store: ConfigStore, over: Partial<RequestItem> = {}): Promise<string> {
  await seedRequests(store, PROJECT, 'sari', 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    targetAddress: 'aws_ebs_volume.dwh01',
    approvalsRequired: 2,
    approvals: [
      { user: 'budi', at: '2026-07-30T00:00:00.000Z' },
      { user: 'lina', at: '2026-07-30T01:00:00.000Z' },
    ],
    schedule: WINDOW,
    ...over,
  });
  return 'seed-sari-0';
}

async function getReq(store: ConfigStore, id: string): Promise<RequestItem> {
  const item = (await store.get(`P#${PROJECT}#REQ#${id}`, 'META')) as RequestItem | null;
  if (!item) throw new Error(`request ${id} not found`);
  return item;
}

async function auditActions(store: ConfigStore, id: string): Promise<string[]> {
  const entries = (await store.query(`P#${PROJECT}#AUDIT#${AUDIT_PARTITION}`)) as AuditItem[];
  return entries.filter((e) => e.requestId === id).map((e) => e.action);
}

function recorder(): { notifier: Notifier; events: SchedulerNotification[] } {
  const events: SchedulerNotification[] = [];
  return { notifier: { notify: (n) => void events.push(n) }, events };
}

/** An executor that fails loudly if the scheduler ever tries to apply an unpinned change. */
const neverApplies: ApplyExecutor = {
  replan: async () => {
    throw new Error('replan must NEVER be reached without a pin');
  },
  apply: async () => {
    throw new Error('apply must NEVER be reached without a pin');
  },
  revert: async () => ({ ok: true, detail: 'x' }),
};

async function cancel(app: Hono<AppEnv>, cookie: string, id: string): Promise<Response> {
  return app.request(`/requests/${id}/cancel`, {
    method: 'POST',
    headers: { 'x-ccp-client': 'ccp-spa', cookie, 'x-ccp-project': PROJECT },
  });
}

afterEach(() => __setNow(null));

describe('pinStateOf — absent and corrupt are not the same thing', () => {
  it('separates the three states, and only a self-consistent pair is intact', () => {
    expect(pinStateOf({})).toBe('absent');
    expect(pinStateOf({ pinnedDiff: '', planDigest: '' })).toBe('absent'); // empty is not "written"
    expect(pinStateOf({ pinnedDiff: PINNED_DIFF })).toBe('corrupt'); // half a pin
    expect(pinStateOf({ planDigest: digestOf(PINNED_DIFF) })).toBe('corrupt'); // the other half
    expect(pinStateOf({ pinnedDiff: PINNED_DIFF, planDigest: 'deadbeef' })).toBe('corrupt'); // tampered
    expect(pinStateOf({ pinnedDiff: PINNED_DIFF, planDigest: digestOf(PINNED_DIFF) })).toBe('intact');
  });
});

describe('API-3 — an unpinned request is HELD, not destroyed', () => {
  it('the scheduler leaves it in AWAITING_DEPLOY_APPROVAL and never applies it', async () => {
    const store = new MemoryStore();
    const id = await seedUnpinned(store);

    const outcomes = await runDueApplies(store, PROJECT, NOW, neverApplies, {});

    // THE REGRESSION. Before the fix this was
    // `[{ requestId: id, result: 'halted', haltReason: 'NO_PINNED_PLAN' }]` and the row
    // read HALTED_DRIFT — a status no route in the API could act on.
    expect(outcomes).toEqual([{ requestId: id, result: 'held-no-plan' }]);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('the held request is still cancellable — arming the scheduler does not strand it', async () => {
    const store = new MemoryStore();
    await seed(store);
    const app = createApp(store);
    const id = await seedUnpinned(store);
    __setNow(() => NOW);

    await runDueApplies(store, PROJECT, NOW, neverApplies, {});

    // The tick must not have moved it out of a status the product can act on. (With the
    // halt restored this reads HALTED_DRIFT, and only API-2's widened cancel saves it —
    // which is a second net, not this one.)
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');

    const res = await cancel(app, await sessionCookieFor(store, 'sari'), id);
    expect(res.status).toBe(200);
    expect((await getReq(store, id)).status).toBe('CANCELLED');
  });

  it('records the reason ONCE — audited and on the timeline, then silent forever', async () => {
    const store = new MemoryStore();
    const id = await seedUnpinned(store);
    const { notifier, events } = recorder();

    await runDueApplies(store, PROJECT, NOW, neverApplies, { notifier });

    const held = (await getReq(store, id)).events.filter((e) => e.type === HELD_NO_PLAN_EVENT);
    expect(held).toHaveLength(1); // the requester sees WHY nothing applied
    expect(await auditActions(store, id)).toContain('scheduler-hold-noplan');
    expect(events.map((e) => e.kind)).toEqual(['held-no-plan']);

    // Ten more ticks (the loop runs every 60 s, forever). None of them writes anything:
    // a per-tick audit entry against the per-project chain head would be unbounded growth
    // on a row that is simply waiting.
    for (let i = 0; i < 10; i++) {
      expect(await runDueApplies(store, PROJECT, NOW + i * 60_000, neverApplies, { notifier })).toEqual([
        { requestId: id, result: 'held-no-plan' },
      ]);
    }
    expect((await getReq(store, id)).events.filter((e) => e.type === HELD_NO_PLAN_EVENT)).toHaveLength(1);
    expect((await auditActions(store, id)).filter((a) => a === 'scheduler-hold-noplan')).toHaveLength(1);
    expect(events).toHaveLength(1);
  });

  it('a HALF-written pin still HALTS — the hold is for "never written", not for "damaged"', async () => {
    for (const partial of [{ pinnedDiff: PINNED_DIFF }, { planDigest: digestOf(PINNED_DIFF) }]) {
      const store = new MemoryStore();
      const id = await seedUnpinned(store, partial);
      const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), {});
      expect(outcomes, JSON.stringify(partial)).toEqual([{ requestId: id, result: 'halted', haltReason: 'NO_PINNED_PLAN' }]);
      expect((await getReq(store, id)).status).toBe(HALTED_DRIFT);
    }
  });
});
