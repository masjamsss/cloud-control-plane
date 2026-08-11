import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore, Item, TransactWrite } from '../src/store/configStore';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { requestKey } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seedRequests } from './helpers/seed';
import { settleWindow } from '../src/domain/schedule';
import { digestOf, type ApplyExecutor } from '../src/domain/apply/executor';
import { REPLAN_FAILED_EVENT, runDueApplies } from '../src/domain/apply/scheduler';
import type { Notifier, SchedulerNotification } from '../src/domain/apply/notify';

/**
 * ERR-6 — `executor.replan()` was called bare while `executor.apply` was wrapped, so a
 * `terraform plan` that would not run (backend unreachable, bad config, ERR-5's cached
 * init rejection) threw straight out of `processOne`, out of `runDueApplies` — taking
 * every LATER due request in the project with it — and was swallowed by `loop.ts`'s
 * per-project `console.error`. The failing request was retried every tick with no
 * timeline event, no audit entry and no notification; its siblings silently missed their
 * maintenance windows as collateral.
 *
 * Two properties are pinned here, and they are separable on purpose:
 *
 *  1. THE FAILURE IS MODELLED — a re-plan that cannot run HOLDS the request where it is
 *     and records ONE event + audit entry + notification per failure episode. It does
 *     NOT halt: see `holdReplanFailed`'s comment for why the finding's own "halt after N
 *     consecutive failures" recommendation is rejected, and the last test here for the
 *     bounded ending that already existed and would have been thrown away by it.
 *  2. THE BLAST RADIUS IS ONE REQUEST — an unexpected throw anywhere in one request's
 *     processing cannot skip its siblings.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z'); // inside [00:00, 04:00)
const AFTER_WINDOW = Date.parse('2026-08-01T05:00:00.000Z');
const AUDIT_PARTITION = '202608';

/** `n` due, fully-approved, windowed requests with intact pins. Ids: `seed-sari-0…n-1`. */
async function seedDue(store: ConfigStore, n: number, over: Partial<RequestItem> = {}): Promise<string[]> {
  await seedRequests(store, PROJECT, 'sari', n, {
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
    planDigest: PINNED_DIGEST,
    pinnedDiff: PINNED_DIFF,
    ...over,
  });
  return Array.from({ length: n }, (_, i) => `seed-sari-${i}`);
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

function recorder(): { notifier: Notifier; events: SchedulerNotification[] } {
  const events: SchedulerNotification[] = [];
  return { notifier: { notify: (n) => void events.push(n) }, events };
}

/** An executor whose re-plan throws for the named requests and works for the rest. */
function replanFailsFor(ids: Set<string>, calls: string[] = []): ApplyExecutor & { calls: string[] } {
  return {
    calls,
    kind: 'dry-run',
    replan: async (r) => {
      calls.push(`replan:${r.id}`);
      if (ids.has(r.id)) throw new Error('terraform plan failed: Error: failed to query available provider packages');
      return { diff: r.pinnedDiff ?? '', digest: r.planDigest ?? '' };
    },
    apply: async (r) => {
      calls.push(`apply:${r.id}`);
      return { ok: true, dryRun: true, detail: `DRY-RUN — would apply ${r.id}` };
    },
    revert: async () => ({ ok: true, detail: 'x' }),
  };
}

afterEach(() => __setNow(null));

describe('ERR-6 — a re-plan that will not run is a modelled outcome, not an escape', () => {
  it('holds the request, records ONE event + audit entry + notification, and never halts', async () => {
    const store = new MemoryStore();
    const [id] = await seedDue(store, 1);
    const { notifier, events } = recorder();
    const ex = replanFailsFor(new Set([id!]));

    // THE REGRESSION. Before the fix this call REJECTED — the executor's error escaped
    // `runDueApplies` entirely, so there was no outcome to inspect at all.
    const outcomes = await runDueApplies(store, PROJECT, NOW, ex, { notifier });

    expect(outcomes).toEqual([
      { requestId: id, result: 'replan-failed', detail: expect.stringContaining('terraform plan failed') },
    ]);
    // Setup assertion (L-1): the re-plan really was attempted and really refused.
    expect(ex.calls).toEqual([`replan:${id}`]);

    const req = await getReq(store, id!);
    expect(req.status).toBe('AWAITING_DEPLOY_APPROVAL'); // held, not halted, not applied
    expect(req.events.filter((e) => e.type === REPLAN_FAILED_EVENT)).toHaveLength(1);
    expect(req.events.at(-1)?.label).toContain('could not re-plan');
    expect(await auditActions(store, id!)).toEqual(['scheduler-replan-failed']);
    expect(events.map((e) => e.kind)).toEqual(['replan-failed']);
  });

  it('records once per EPISODE: a tick that fails again writes nothing, a later episode writes again', async () => {
    const store = new MemoryStore();
    const [id] = await seedDue(store, 1);
    const ex = replanFailsFor(new Set([id!]));

    await runDueApplies(store, PROJECT, NOW, ex, {});
    await runDueApplies(store, PROJECT, NOW + 60_000, ex, {});

    // The second tick really ran and really failed — it just wrote nothing. Without this
    // assertion a scheduler that had stopped looking at the row would pass identically.
    expect(ex.calls).toEqual([`replan:${id}`, `replan:${id}`]);
    expect((await getReq(store, id!)).events.filter((e) => e.type === REPLAN_FAILED_EVENT)).toHaveLength(1);
    expect(await auditActions(store, id!)).toEqual(['scheduler-replan-failed']);

    // Anything else touching the request (a rewindow, an approval, a settle) ends the
    // episode: the marker is no longer the LAST event, so the next failure is news again.
    const req = await getReq(store, id!);
    const k = requestKey(PROJECT, id!);
    await store.put({ ...req, events: [...req.events, { at: '2026-08-01T01:30:00.000Z', type: 'rewindowed', label: 'Re-windowed' }] } as Item);
    await runDueApplies(store, PROJECT, NOW + 120_000, ex, {});

    expect((await getReq(store, id!)).events.filter((e) => e.type === REPLAN_FAILED_EVENT)).toHaveLength(2);
    expect(await auditActions(store, id!)).toEqual(['scheduler-replan-failed', 'scheduler-replan-failed']);
    expect(k.PK).toContain(id!); // key built from the key function, never hand-typed
  });

  it('ONE failing request does not starve its siblings of their window', async () => {
    const store = new MemoryStore();
    const ids = await seedDue(store, 3);
    const failing = ids[0]!;
    const ex = replanFailsFor(new Set([failing]));

    const outcomes = await runDueApplies(store, PROJECT, NOW, ex, {});

    // THE REGRESSION. Before the fix the first request's throw ended the loop: requests
    // 1 and 2 were never processed, on this tick and on every tick after it.
    expect(outcomes.map((o) => o.result)).toEqual(['replan-failed', 'applied', 'applied']);
    expect((await getReq(store, ids[1]!)).status).toBe('APPLIED');
    expect((await getReq(store, ids[2]!)).status).toBe('APPLIED');
    // Setup assertion: the failing request WAS first in the due list, so the siblings
    // really were downstream of the throw.
    expect(ex.calls[0]).toBe(`replan:${failing}`);
  });

  it('an UNEXPECTED throw (not the executor) is isolated too, and reported as `errored`', async () => {
    const inner = new MemoryStore();
    const ids = await seedDue(inner, 2);
    const poisoned = ids[0]!;
    const poisonedKey = requestKey(PROJECT, poisoned);
    let poisonedWrites = 0;
    // A store that refuses the claim write for ONE request — standing in for any
    // unexpected fault below the scheduler (a durability fault, a chain-head failure).
    const store: ConfigStore = {
      ...inner,
      get: (pk, sk) => inner.get(pk, sk),
      put: (item, opts) => inner.put(item, opts),
      query: (pk, prefix, opts) => inner.query(pk, prefix, opts),
      queryGSI1: (gsi, opts) => inner.queryGSI1(gsi, opts),
      delete: (pk, sk) => inner.delete(pk, sk),
      transact: async (writes: TransactWrite[]) => {
        const touchesPoisoned = writes.some((w) => (w.kind === 'put' ? w.item.PK : w.pk) === poisonedKey.PK);
        if (touchesPoisoned) {
          poisonedWrites++;
          throw new Error('store exploded');
        }
        return inner.transact(writes);
      },
    };
    const { notifier, events } = recorder();

    const outcomes = await runDueApplies(store, PROJECT, NOW, replanFailsFor(new Set()), { notifier });

    expect(outcomes).toEqual([
      { requestId: poisoned, result: 'errored', detail: 'store exploded' },
      { requestId: ids[1], result: 'applied' },
    ]);
    expect(poisonedWrites).toBeGreaterThan(0); // the fault really fired (L-1)
    expect(events.map((e) => e.kind)).toContain('tick-error');
    expect((await getReq(inner, ids[1]!)).status).toBe('APPLIED');
  });

  it('a throwing NOTIFIER cannot take the tick down either', async () => {
    const store = new MemoryStore();
    const ids = await seedDue(store, 2);
    const explode: Notifier = {
      notify: (n) => {
        if (n.requestId === ids[0]) throw new Error('pager is down');
      },
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, replanFailsFor(new Set()), { notifier: explode });

    expect(outcomes.map((o) => o.result)).toEqual(['errored', 'applied']);
    expect((await getReq(store, ids[1]!)).status).toBe('APPLIED');
  });
});

describe('ERR-6 — the retry is bounded by the window, which is why holding is safe', () => {
  it('a permanently failing re-plan stops being retried when the window closes, and settles to WINDOW_EXPIRED', async () => {
    const store = new MemoryStore();
    const [id] = await seedDue(store, 1);
    const ex = replanFailsFor(new Set([id!]));

    expect((await runDueApplies(store, PROJECT, NOW, ex, {}))[0]!.result).toBe('replan-failed');
    expect(ex.calls).toHaveLength(1); // in-window: attempted

    // Window shut. The row is no longer due, so the scheduler stops touching it — the
    // "unbounded silent retry" the finding describes ends here, without a halt.
    expect(await runDueApplies(store, PROJECT, AFTER_WINDOW, ex, {})).toEqual([]);
    expect(ex.calls).toHaveLength(1); // no second attempt — the bound really is the window

    // And the row has a real ending that KEEPS its approvals: WINDOW_EXPIRED is parked,
    // with rewindow and cancel as exits. A `REPLAN_FAILED` halt would have replaced this
    // recoverable ending with one that only cancel can leave.
    __setNow(() => AFTER_WINDOW);
    expect((await settleWindow(store, PROJECT, await getReq(store, id!))).status).toBe('WINDOW_EXPIRED');
  });
});
