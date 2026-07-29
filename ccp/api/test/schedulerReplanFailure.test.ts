import { describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { seedRequests } from './helpers/seed';
import { digestOf, DryRunExecutor, type ApplyExecutor, type PlanResult } from '../src/domain/apply/executor';
import { HALTED_DRIFT, REPLAN_FAILURE_LIMIT, runDueApplies } from '../src/domain/apply/scheduler';
import type { Notifier, SchedulerNotification } from '../src/domain/apply/notify';

/**
 * ERR-6 — `executor.replan()` failures were an unmodeled halt: unbounded silent retry,
 * and they aborted the rest of the project's due list.
 *
 * `processOne` wrapped `executor.apply` in `tryApply` but called `executor.replan(req)`
 * bare. `TerraformExecutor.replan` throws on any plan failure — backend unreachable, bad
 * credentials, a config error, ERR-5's cached init rejection — and the exception
 * propagated out of `processOne`, out of `runDueApplies` (whose due loop had no
 * per-request catch), and into a per-project `console.error` in `loop.ts`.
 *
 * Two consequences, and the second is the one nobody would find:
 *
 *  1. The failing request was retried EVERY TICK FOREVER with no `HALTED_*` transition, no
 *     timeline event and no notifier alert. Stdout was the only trace, so in the portal it
 *     looked exactly as if the scheduler had never run.
 *  2. Every LATER due request in the same project was skipped for that tick — every tick.
 *     A perfectly healthy change silently missed its maintenance window because a
 *     different request was broken.
 *
 * The fix is deliberately not "halt on the first failure". Failing to PRODUCE a plan is
 * not the same as producing one that drifted — nothing about the change is known to be
 * wrong, only unverified — and the sole exit from a halt is cancel + resubmit through the
 * approval ladder. Paying that for a thirty-second network fault would be its own defect.
 * So: retry, but boundedly (halt at {@link REPLAN_FAILURE_LIMIT}) and visibly (report the
 * first failure of an episode once, count the rest silently).
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z');
const AUDIT_PARTITION = '202608';

async function seedDue(store: ConfigStore, user: string, over: Partial<RequestItem> = {}): Promise<string> {
  await seedRequests(store, PROJECT, user, 1, {
    status: 'AWAITING_DEPLOY_APPROVAL',
    exposure: 'l1_with_guardrails',
    operationId: 'ebs-grow',
    targetAddress: `aws_ebs_volume.${user}`,
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
  return `seed-${user}-0`;
}

async function getReq(store: ConfigStore, id: string): Promise<RequestItem> {
  const item = (await store.get(`P#${PROJECT}#REQ#${id}`, 'META')) as RequestItem | null;
  if (!item) throw new Error(`request ${id} not found`);
  return item;
}

async function auditEntries(store: ConfigStore, requestId?: string): Promise<AuditItem[]> {
  const entries = (await store.query(`P#${PROJECT}#AUDIT#${AUDIT_PARTITION}`)) as AuditItem[];
  return entries.filter((e) => (requestId === undefined ? true : e.requestId === requestId));
}

function recorder(): { notifier: Notifier; events: SchedulerNotification[] } {
  const events: SchedulerNotification[] = [];
  return { notifier: { notify: (n) => void events.push(n) }, events };
}

/** An executor whose replan throws — exactly what TerraformExecutor does on a plan failure. */
function replanThrows(message = 'terraform plan failed: Error: backend unreachable'): ApplyExecutor {
  const base = new DryRunExecutor();
  return {
    kind: 'dry-run',
    replan(): Promise<PlanResult> {
      return Promise.reject(new Error(message));
    },
    apply: (r) => base.apply(r),
    revert: (r) => base.revert(r),
  };
}

/** Throws for the first `n` replans, then behaves — a transient backend fault. */
function replanThrowsTimes(n: number): ApplyExecutor {
  const base = new DryRunExecutor();
  let calls = 0;
  return {
    kind: 'dry-run',
    replan(req) {
      calls += 1;
      if (calls <= n) return Promise.reject(new Error('terraform plan failed: Error: backend unreachable'));
      return base.replan(req);
    },
    apply: (r) => base.apply(r),
    revert: (r) => base.revert(r),
  };
}

const run = (store: ConfigStore, ex: ApplyExecutor, notifier?: Notifier) =>
  runDueApplies(store, PROJECT, NOW, ex, { ...(notifier ? { notifier } : {}), idFn: (() => { let n = 0; return () => `01J${String(n++).padStart(23, '0')}`; })() });

describe('ERR-6 — a replan that throws is a modelled outcome', () => {
  it('THE DEFECT: the throw used to escape runDueApplies entirely', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, 'sari');

    // Under the defect this REJECTED — the exception left the scheduler.
    const outcomes = await run(store, replanThrows());

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.result).toBe('replan-error');
    expect(outcomes[0]!.detail, 'the reason is carried, not swallowed').toMatch(/backend unreachable/);
    expect((await getReq(store, id)).status, 'and it does NOT halt on the first failure').toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('THE DEFECT: one broken request used to skip every later due request in the project', async () => {
    // The collateral damage, and the part that would never be traced back to its cause:
    // a perfectly healthy change silently misses its window because a DIFFERENT request
    // cannot be re-planned.
    const store = new MemoryStore();
    const broken = await seedDue(store, 'sari');
    const healthy = await seedDue(store, 'dewi');

    // Fails only for the first request the scheduler reaches, whichever that is.
    const base = new DryRunExecutor();
    const executor: ApplyExecutor = {
      kind: 'dry-run',
      replan: (r) => (r.id === broken ? Promise.reject(new Error('terraform plan failed: Error: backend unreachable')) : base.replan(r)),
      apply: (r) => base.apply(r),
      revert: (r) => base.revert(r),
    };

    const outcomes = await run(store, executor);

    expect(outcomes, 'BOTH requests must be reported on — not just the ones before the failure').toHaveLength(2);
    expect(outcomes.find((o) => o.requestId === broken)!.result).toBe('replan-error');
    expect(
      outcomes.find((o) => o.requestId === healthy)!.result,
      'THE DEFECT: this request used to be skipped every tick, forever, as collateral',
    ).toBe('applied');
    expect((await getReq(store, healthy)).status).toBe('APPLIED');
  });

  it('reports the FIRST failure of an episode — timeline, audit chain and an alert', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, 'sari');
    const { notifier, events } = recorder();

    await run(store, replanThrows(), notifier);

    const req = await getReq(store, id);
    expect(req.replanFailures).toBe(1);
    const ev = req.events.find((e) => e.type === 'replan_failed');
    expect(ev, 'the request timeline says why nothing happened').toBeTruthy();
    expect(ev!.label).toMatch(/backend unreachable/);
    expect(ev!.label, 'and that it will be retried, with the bound').toMatch(new RegExp(`1 of ${REPLAN_FAILURE_LIMIT}`));

    const entries = await auditEntries(store, id);
    expect(entries.some((e) => e.action === 'scheduler-replan-failed'), 'and the audit chain records it').toBe(true);
    expect(events.map((e) => e.kind), 'and a human is alerted once').toContain('replan-failed');
  });

  it('stays QUIET on later ticks of the same episode — one alert a minute forever is not an alert', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, 'sari');
    const { notifier, events } = recorder();

    await run(store, replanThrows(), notifier);
    await run(store, replanThrows(), notifier);
    await run(store, replanThrows(), notifier);

    const req = await getReq(store, id);
    expect(req.replanFailures, 'every tick still COUNTS').toBe(3);
    expect(
      req.events.filter((e) => e.type === 'replan_failed'),
      'but the timeline is appended to once, not once per minute forever',
    ).toHaveLength(1);
    expect((await auditEntries(store, id)).filter((e) => e.action === 'scheduler-replan-failed')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'replan-failed'), 'and the alert fires once per episode').toHaveLength(1);
  });

  it('HALTS at the limit — "we could not check this change" eventually reaches a human', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, 'sari');
    const { notifier, events } = recorder();

    let last;
    for (let i = 0; i < REPLAN_FAILURE_LIMIT; i++) last = await run(store, replanThrows(), notifier);

    expect(last![0]!.result).toBe('halted');
    expect(last![0]!.haltReason).toBe('REPLAN_FAILED');
    const req = await getReq(store, id);
    expect(req.status, 'halted to a fresh plan/review — it is not drift, but it is unverified').toBe(HALTED_DRIFT);
    expect(req.events.some((e) => e.type === 'halted')).toBe(true);
    expect(events.map((e) => e.kind)).toContain('halted-replan');

    // And the halt is an exit, not a dead end (API-2's rule): cancel accepts HALTED_DRIFT.
    expect((await auditEntries(store, id)).some((e) => e.action === 'scheduler-halt-replan')).toBe(true);
  });

  it('does not halt one tick EARLY or one tick LATE', async () => {
    // An off-by-one here means either a transient blip halts a fully approved change, or
    // the bound the comment promises is not the bound the code enforces.
    const store = new MemoryStore();
    const id = await seedDue(store, 'sari');

    for (let i = 0; i < REPLAN_FAILURE_LIMIT - 1; i++) {
      const o = await run(store, replanThrows());
      expect(o[0]!.result, `tick ${i + 1} must still be retrying`).toBe('replan-error');
      expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
    }
    expect((await run(store, replanThrows()))[0]!.result, 'and the LIMIT-th halts').toBe('halted');
  });

  it('a RECOVERED replan clears the counter, so a later fault is a new episode', async () => {
    // Without this, a request that blipped four times a month ago would halt on its next
    // single failure — and the alert for that failure would never fire, because the
    // episode would look like it was already in progress.
    const store = new MemoryStore();
    const id = await seedDue(store, 'sari');
    const { notifier, events } = recorder();

    // Two failures, then the backend comes back. The request is due but its window is
    // still open, so the recovered tick proceeds to apply.
    const executor = replanThrowsTimes(2);
    await run(store, executor, notifier);
    await run(store, executor, notifier);
    expect((await getReq(store, id)).replanFailures).toBe(2);

    const recovered = await run(store, executor, notifier);
    expect(recovered[0]!.result).toBe('applied');
    expect(events.filter((e) => e.kind === 'replan-failed'), 'one episode, one alert').toHaveLength(1);
  });

  it('a healthy project is untouched — no counter, no events, no alerts', async () => {
    // The guard against a fix that taxes the normal path.
    const store = new MemoryStore();
    const id = await seedDue(store, 'sari');
    const { notifier, events } = recorder();

    expect((await run(store, new DryRunExecutor(), notifier))[0]!.result).toBe('applied');
    const req = await getReq(store, id);
    expect(req.replanFailures).toBeUndefined();
    expect(req.events.some((e) => e.type === 'replan_failed')).toBe(false);
    expect(events.some((e) => e.kind === 'replan-failed')).toBe(false);
  });
});

describe('ERR-6 — the per-request backstop bounds the blast radius of ANY throw', () => {
  it('an unexpected throw costs ONE request, not the whole due list', async () => {
    // The modelled failures are handled where they happen — replan here, apply in
    // `tryApply`. This is the catch-all underneath them, and reaching it needs a throw
    // from a path neither of those wraps. `processOne` AWAITS `notifier.notify`, so an
    // alerting channel that is down is exactly such a path, and a realistic one: a
    // webhook 500 must not cancel the maintenance window for every other change.
    const store = new MemoryStore();
    const boom = await seedDue(store, 'sari');
    const healthy = await seedDue(store, 'dewi');

    const seen: SchedulerNotification[] = [];
    const flaky: Notifier = {
      notify(n) {
        seen.push(n);
        if (n.requestId === boom) throw new Error('alert webhook returned 500');
      },
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { notifier: flaky });

    expect(outcomes, 'both requests are accounted for').toHaveLength(2);
    expect(outcomes.find((o) => o.requestId === boom)!.result).toBe('error');
    expect(outcomes.find((o) => o.requestId === boom)!.detail).toMatch(/alert webhook returned 500/);
    expect(
      outcomes.find((o) => o.requestId === healthy)!.result,
      'THE POINT: the healthy request still applies in the same tick',
    ).toBe('applied');
    expect((await getReq(store, healthy)).status).toBe('APPLIED');
  });

  it('a notifier that throws on EVERY request cannot wedge the tick either', async () => {
    // The backstop reports through the notifier too. When that is the thing that is
    // broken, the report must not rethrow out of the handler — which would re-open the
    // exact starvation the catch exists to close. This failed the first time it was run.
    const store = new MemoryStore();
    await seedDue(store, 'sari');
    await seedDue(store, 'dewi');

    const alwaysThrows: Notifier = {
      notify() {
        throw new Error('alert channel is down');
      },
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, new DryRunExecutor(), { notifier: alwaysThrows });
    expect(outcomes, 'every due request is still reported on').toHaveLength(2);
    expect(outcomes.every((o) => o.result === 'error')).toBe(true);
  });
});
