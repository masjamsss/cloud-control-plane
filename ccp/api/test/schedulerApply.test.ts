import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../src/store/memoryStore';
import type { ConfigStore } from '../src/store/configStore';
import type { AuditItem, RequestItem } from '../src/store/schema';
import { __setNow } from '../src/clock';
import { seedRequests, setSetting } from './helpers/seed';
import { digestOf, DryRunExecutor, type ApplyExecutor } from '../src/domain/apply/executor';
import {
  APPLYING,
  isDue,
  isPinIntact,
  runDueApplies,
  SCHEDULER_ACTOR,
  HALTED_DRIFT,
  HALTED_APPLY_FAILED,
  type ApplyOutcome,
} from '../src/domain/apply/scheduler';
import type { Notifier, SchedulerNotification } from '../src/domain/apply/notify';

/**
 * 0038 T2/T3 — the DRY-RUN scheduled auto-apply engine. The RISKIEST subsystem: the
 * first thing that will EVENTUALLY change live production at a scheduled time with no
 * human present. Everything here is DRY-RUN (no terraform, no AWS) and the pure core
 * `runDueApplies` drives `now` as a parameter so every path is a deterministic table
 * test. The invariants the adversarial reviewer attacks live at the bottom of this file.
 */

const PROJECT = 'sample';
const PINNED_DIFF = 'plan: aws_ebs_volume.dwh01 size 200 -> 250 GiB (in-place)';
const PINNED_DIGEST = digestOf(PINNED_DIFF);
const WINDOW = { kind: 'window' as const, at: '2026-08-01T00:00:00.000Z', endAt: '2026-08-01T04:00:00.000Z' };
const NOW = Date.parse('2026-08-01T01:00:00.000Z'); // inside [00:00, 04:00)
const BEFORE = Date.parse('2026-07-31T23:00:00.000Z'); // before the window opens
const AFTER = Date.parse('2026-08-01T05:00:00.000Z'); // after the window closes
const AUDIT_PARTITION = '202608'; // yyyymm(NOW) — audit entries are stamped from `now`

/** Seed one due, fully-approved, windowed AWAITING_DEPLOY_APPROVAL request with an intact pin. */
async function seedDue(store: ConfigStore, over: Partial<RequestItem> = {}): Promise<string> {
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
    planDigest: PINNED_DIGEST,
    pinnedDiff: PINNED_DIFF,
    ...over,
  });
  return 'seed-sari-0';
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

/** The default ship-it executor never applies for real, so match-and-apply lands APPLIED. */
function dryRun(): ApplyExecutor {
  return new DryRunExecutor();
}

afterEach(() => __setNow(null));

/* ── pure helpers ──────────────────────────────────────────────────────────── */

describe('pure helpers — digestOf / isPinIntact / isDue', () => {
  it('digestOf is a stable sha256 hex of the diff text', () => {
    expect(digestOf('x')).toBe(digestOf('x'));
    expect(digestOf('x')).not.toBe(digestOf('y'));
    expect(digestOf(PINNED_DIFF)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('isPinIntact requires BOTH pinnedDiff and planDigest present AND self-consistent', () => {
    expect(isPinIntact({ pinnedDiff: PINNED_DIFF, planDigest: PINNED_DIGEST } as RequestItem)).toBe(true);
    expect(isPinIntact({ pinnedDiff: PINNED_DIFF, planDigest: 'deadbeef' } as RequestItem)).toBe(false); // corrupt
    expect(isPinIntact({ planDigest: PINNED_DIGEST } as RequestItem)).toBe(false); // no diff
    expect(isPinIntact({ pinnedDiff: PINNED_DIFF } as RequestItem)).toBe(false); // no digest
    expect(isPinIntact({} as RequestItem)).toBe(false); // neither
  });

  it('isDue is true ONLY for a windowed AWAITING_DEPLOY_APPROVAL request inside its window', () => {
    const base = { status: 'AWAITING_DEPLOY_APPROVAL', schedule: WINDOW } as RequestItem;
    expect(isDue(base, NOW)).toBe(true);
    expect(isDue(base, BEFORE)).toBe(false); // not yet open
    expect(isDue(base, AFTER)).toBe(false); // already closed
    expect(isDue({ ...base, status: 'APPLIED' } as RequestItem, NOW)).toBe(false); // wrong status
    expect(isDue({ ...base, status: 'AWAITING_CODE_REVIEW' } as RequestItem, NOW)).toBe(false); // still open
    expect(isDue({ ...base, status: APPLYING } as RequestItem, NOW)).toBe(false); // already claimed (not re-claimable)
    expect(isDue({ status: 'AWAITING_DEPLOY_APPROVAL', schedule: { kind: 'now' } } as RequestItem, NOW)).toBe(false); // no window
  });
});

/* ── DryRunExecutor — the ONLY executor that ships ──────────────────────────── */

describe('DryRunExecutor — no terraform, no AWS, no store writes', () => {
  it('replan returns the request\'s ALREADY-PINNED plan/digest verbatim', async () => {
    const ex = dryRun();
    const req = { pinnedDiff: PINNED_DIFF, planDigest: PINNED_DIGEST } as RequestItem;
    const r = await ex.replan(req);
    expect(r.diff).toBe(PINNED_DIFF);
    expect(r.digest).toBe(PINNED_DIGEST);
  });

  it('apply is a clearly-marked DRY-RUN and does NOT mutate the store', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    const before = await getReq(store, id);
    const ex = dryRun();
    const res = await ex.apply(before);
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/DRY-RUN/);
    expect(res.appliedSha).toMatch(/^DRYRUN-/);
    // the executor itself writes NOTHING — the request is untouched by apply()
    expect(await getReq(store, id)).toEqual(before);
  });

  it('revert is a clearly-marked DRY-RUN stub', async () => {
    const res = await dryRun().revert({ id: 'x', planDigest: PINNED_DIGEST } as RequestItem);
    expect(res.ok).toBe(true);
    expect(res.detail).toMatch(/DRY-RUN/);
  });
});

/* ── decision path: due + intact + match → dry-run APPLIED ──────────────────── */

describe('due window + intact pin + digest MATCH → dry-run APPLIED', () => {
  it('transitions to APPLIED with a DRY-RUN marker event, appliedSha/evidenceUrl, audit + notify', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    const { notifier, events } = recorder();

    const outcomes = await runDueApplies(store, PROJECT, NOW, dryRun(), { notifier });

    expect(outcomes).toEqual([{ requestId: id, result: 'applied' }]);
    const req = await getReq(store, id);
    expect(req.status).toBe('APPLIED');
    expect(req.appliedSha).toMatch(/^DRYRUN-/);
    expect(req.evidenceUrl).toBeDefined();
    const applied = req.events.find((e) => e.type === 'applied');
    expect(applied?.label).toMatch(/DRY-RUN/);
    expect(applied?.actor).toBe(SCHEDULER_ACTOR);

    // audit: a claim/start entry AND an applied entry, both under system:scheduler. The
    // claim-first flow makes the state ladder auditable: AWAITING → APPLYING → APPLIED.
    const entries = await auditEntries(store, id);
    const actions = entries.map((e) => e.action);
    expect(actions).toContain('scheduler-apply-start');
    expect(actions).toContain('scheduler-applied');
    for (const e of entries) expect(e.actor).toBe(SCHEDULER_ACTOR);
    const startEntry = entries.find((e) => e.action === 'scheduler-apply-start')!;
    expect((startEntry.before as { status: string }).status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect((startEntry.after as { status: string }).status).toBe(APPLYING);
    const appliedEntry = entries.find((e) => e.action === 'scheduler-applied')!;
    expect((appliedEntry.before as { status: string }).status).toBe(APPLYING); // claimed, then applied
    expect((appliedEntry.after as { status: string }).status).toBe('APPLIED');

    // notify: started + applied
    expect(events.map((e) => e.kind)).toEqual(expect.arrayContaining(['apply-started', 'applied']));
  });

  it('idempotent: a second run finds it APPLIED (no longer due) → applies exactly once', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    await runDueApplies(store, PROJECT, NOW, dryRun(), {});
    const second = await runDueApplies(store, PROJECT, NOW, dryRun(), {});
    expect(second).toEqual([]); // nothing due the second time
    const appliedEntries = (await auditEntries(store, id)).filter((e) => e.action === 'scheduler-applied');
    expect(appliedEntries).toHaveLength(1);
  });
});

/* ── decision path: NOT due → skipped, zero writes ──────────────────────────── */

describe('not-yet-due / already-expired → nothing runs', () => {
  it('before the window opens → skipped, status unchanged, no audit', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    const outcomes = await runDueApplies(store, PROJECT, BEFORE, dryRun(), {});
    expect(outcomes).toEqual([]);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
    expect(await auditEntries(store, id)).toHaveLength(0);
  });

  it('after the window closes → not due (settlement/expiry is the read path\'s job, not the scheduler\'s)', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    const outcomes = await runDueApplies(store, PROJECT, AFTER, dryRun(), {});
    expect(outcomes).toEqual([]);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });
});

/* ── decision path: missing / corrupt pinned plan → HALT (never apply) ──────── */

describe('missing or corrupt pinned plan → HALT, never apply', () => {
  it('absent planDigest+pinnedDiff → HALTED_DRIFT, no apply attempted, audited + notified', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, { planDigest: undefined, pinnedDiff: undefined });
    const { notifier, events } = recorder();
    const applyGuard: ApplyExecutor = {
      replan: async () => ({ diff: '', digest: '' }),
      apply: async () => {
        throw new Error('apply must NEVER be called without an intact pin');
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, applyGuard, { notifier });

    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'NO_PINNED_PLAN' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_DRIFT);
    const actions = (await auditEntries(store, id)).map((e) => e.action);
    expect(actions).toContain('scheduler-halt-noplan');
    expect(events.map((e) => e.kind)).toContain('halted-no-plan');
  });

  it('corrupt pin (digest does not match its diff) → HALTED_DRIFT, never apply', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, { planDigest: 'deadbeefdeadbeef' }); // diff intact, digest wrong
    const outcomes = await runDueApplies(store, PROJECT, NOW, dryRun(), {});
    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'NO_PINNED_PLAN' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_DRIFT);
  });
});

/* ── decision path: drift (digest MISMATCH at re-plan) → HALT, route to review ─ */

describe('drift — re-plan digest differs from the approved digest → HALT, not apply', () => {
  it('a drifting executor makes the scheduler HALT to HALTED_DRIFT and NOT apply', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    const { notifier, events } = recorder();
    let applyCalled = false;
    const drifting: ApplyExecutor = {
      // the world moved: re-plan yields a DIFFERENT change than the one reviewed
      replan: async () => ({ diff: 'DRIFTED: also deletes aws_db_instance.prod', digest: digestOf('DRIFTED') }),
      apply: async () => {
        applyCalled = true;
        return { ok: true, detail: 'should never happen' };
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, drifting, { notifier });

    expect(applyCalled).toBe(false); // drift ALWAYS halts before apply
    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'DRIFT' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_DRIFT);
    const actions = (await auditEntries(store, id)).map((e) => e.action);
    expect(actions).toContain('scheduler-halt-drift');
    expect(events.map((e) => e.kind)).toContain('halted-drift');
  });
});

/* ── decision path: quorum guard (defense-in-depth) → HALT ──────────────────── */

describe('defense-in-depth: a request no longer meeting quorum → HALT, never apply', () => {
  it('approvals.length < approvalsRequired → HALTED_DRIFT (never apply)', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, { approvalsRequired: 2, approvals: [{ user: 'budi', at: '2026-07-30T00:00:00.000Z' }] });
    const outcomes = await runDueApplies(store, PROJECT, NOW, dryRun(), {});
    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'QUORUM_LOST' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_DRIFT);
  });
});

/* ── decision path: apply failure → retry once → HALT ───────────────────────── */

describe('apply failure → retry ONCE → then HALT + alert human', () => {
  it('apply that always throws is attempted exactly twice, then HALTED_APPLY_FAILED', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    const { notifier, events } = recorder();
    let applyCalls = 0;
    const failing: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => {
        applyCalls++;
        throw new Error('terraform apply exploded');
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, failing, { notifier });

    expect(applyCalls).toBe(2); // initial + exactly one retry
    expect(outcomes).toEqual([{ requestId: id, result: 'halted', haltReason: 'APPLY_FAILED' }]);
    expect((await getReq(store, id)).status).toBe(HALTED_APPLY_FAILED);
    const actions = (await auditEntries(store, id)).map((e) => e.action);
    expect(actions).toContain('scheduler-apply-failed');
    expect(events.map((e) => e.kind)).toContain('apply-failed');
  });

  it('apply that returns { ok:false } is also retried, then halts (no exception needed)', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    let applyCalls = 0;
    const softFail: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => {
        applyCalls++;
        return { ok: false, detail: 'plan/apply mismatch' };
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };
    const outcomes = await runDueApplies(store, PROJECT, NOW, softFail, {});
    expect(applyCalls).toBe(2);
    expect(outcomes[0]!.haltReason).toBe('APPLY_FAILED');
    expect((await getReq(store, id)).status).toBe(HALTED_APPLY_FAILED);
  });

  it('transient failure that succeeds on the retry → APPLIED', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    let applyCalls = 0;
    const flaky: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => {
        applyCalls++;
        if (applyCalls === 1) throw new Error('transient');
        return { ok: true, detail: 'DRY-RUN applied on retry', appliedSha: 'DRYRUN-retry' };
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };
    const outcomes = await runDueApplies(store, PROJECT, NOW, flaky, {});
    expect(applyCalls).toBe(2);
    expect(outcomes[0]!.result).toBe('applied');
    expect((await getReq(store, id)).status).toBe('APPLIED');
  });
});

/* ── auto-revert is OPT-IN and OFF by default ───────────────────────────────── */

describe('auto-revert is OPT-IN and OFF by default', () => {
  it('by default a failed apply HALTS and does NOT call revert', async () => {
    const store = new MemoryStore();
    await seedDue(store);
    let revertCalled = false;
    const failing: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => ({ ok: false, detail: 'boom' }),
      revert: async () => {
        revertCalled = true;
        return { ok: true, detail: 'x' };
      },
    };
    await runDueApplies(store, PROJECT, NOW, failing, {}); // revertOnFailure unset
    expect(revertCalled).toBe(false);
  });

  it('with revertOnFailure:true a failed apply calls revert (dry-run) and audits it', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    let revertCalled = false;
    const failing: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => ({ ok: false, detail: 'boom' }),
      revert: async () => {
        revertCalled = true;
        return { ok: true, detail: 'DRY-RUN — would revert' };
      },
    };
    await runDueApplies(store, PROJECT, NOW, failing, { revertOnFailure: true });
    expect(revertCalled).toBe(true);
    const actions = (await auditEntries(store, id)).map((e) => e.action);
    expect(actions).toContain('scheduler-revert');
    expect((await getReq(store, id)).status).toBe(HALTED_APPLY_FAILED); // still halted; revert never un-halts
  });
});

/* ── FREEZE halts everything, checked before any apply ──────────────────────── */

describe('freeze halts everything — checked before any apply', () => {
  it('opts.frozen (the master env switch) → audited no-op, nothing applies', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    const { notifier, events } = recorder();
    let applyCalled = false;
    const ex: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => {
        applyCalled = true;
        return { ok: true, detail: 'x' };
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, ex, { frozen: true, notifier });

    expect(applyCalled).toBe(false);
    expect(outcomes).toEqual([{ requestId: id, result: 'skipped-frozen' }]);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL'); // untouched
    const actions = (await auditEntries(store)).map((e) => e.action);
    expect(actions).toContain('scheduler-frozen');
    expect(events.map((e) => e.kind)).toContain('frozen');
  });

  it('the project change-freeze setting (freeze.global) ALSO freezes auto-apply', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    await setSetting(store, PROJECT, 'freeze.global', true);
    const outcomes = await runDueApplies(store, PROJECT, NOW, dryRun(), {}); // no opts.frozen
    expect(outcomes).toEqual([{ requestId: id, result: 'skipped-frozen' }]);
    expect((await getReq(store, id)).status).toBe('AWAITING_DEPLOY_APPROVAL');
  });

  it('freeze with NOTHING due writes no audit (no spam)', async () => {
    const store = new MemoryStore();
    await seedDue(store, { schedule: { kind: 'window', at: WINDOW.at, endAt: WINDOW.endAt }, status: 'APPLIED' });
    const outcomes = await runDueApplies(store, PROJECT, NOW, dryRun(), { frozen: true });
    expect(outcomes).toEqual([]);
    expect(await auditEntries(store)).toHaveLength(0);
  });
});

/* ── only fully-approved AWAITING_DEPLOY_APPROVAL requests are ever touched ──── */

describe('tighten-only: the scheduler only ever acts on AWAITING_DEPLOY_APPROVAL', () => {
  it('open / applied / rejected / cooling requests are never processed', async () => {
    const store = new MemoryStore();
    for (const status of ['AWAITING_CODE_REVIEW', 'NEEDS_ENGINEER', 'APPROVED_COOLING', 'APPLIED', 'REJECTED', 'CANCELLED', 'WINDOW_EXPIRED']) {
      await seedRequests(store, PROJECT, `u-${status}`, 1, {
        status,
        schedule: WINDOW,
        planDigest: PINNED_DIGEST,
        pinnedDiff: PINNED_DIFF,
        approvalsRequired: 1,
        approvals: [{ user: 'budi', at: '2026-07-30T00:00:00.000Z' }],
      });
    }
    const outcomes = await runDueApplies(store, PROJECT, NOW, dryRun(), {});
    expect(outcomes).toEqual([]); // none are AWAITING_DEPLOY_APPROVAL
    expect(await auditEntries(store)).toHaveLength(0);
  });
});

/* ── FINDING 1 regression: overlapping ticks can never double-apply (claim-first) ── */

describe('FINDING 1 regression — overlapping ticks can never double-apply', () => {
  it('a second runDueApplies fired from INSIDE executor.apply() does not re-apply (applyCount===1, loser skipped-moved)', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store);
    let applyCount = 0;
    let fired = false;
    let reentrant: ApplyOutcome[] = [];

    // apply() here simulates tick N+1 firing WHILE tick N is still mid-apply. Without
    // claim-first the row is still AWAITING_DEPLOY_APPROVAL during apply, so the re-entrant
    // run re-passes every guard and applies AGAIN (applyCount -> 2) — this assertion would
    // FAIL. With claim-first, tick N flipped the row to APPLYING BEFORE calling apply, so
    // the re-entrant run sees it already claimed and returns skipped-moved.
    const overlap: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => {
        applyCount++;
        if (!fired) {
          fired = true; // guard unbounded recursion in the (hypothetical) no-claim world
          reentrant = await runDueApplies(store, PROJECT, NOW, overlap, {});
        }
        return { ok: true, detail: 'DRY-RUN applied', appliedSha: 'DRYRUN-x' };
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };

    const outcomes = await runDueApplies(store, PROJECT, NOW, overlap, {});

    expect(applyCount).toBe(1); // apply ran EXACTLY once despite the overlap
    expect(reentrant).toEqual([{ requestId: id, result: 'skipped-moved' }]); // the losing tick
    expect(outcomes).toEqual([{ requestId: id, result: 'applied' }]); // the winning tick
    expect((await getReq(store, id)).status).toBe('APPLIED');
    const appliedEntries = (await auditEntries(store, id)).filter((e) => e.action === 'scheduler-applied');
    expect(appliedEntries).toHaveLength(1); // exactly one applied audit entry
  });

  it('a request already in APPLYING is reported skipped-moved and never (re-)applied', async () => {
    const store = new MemoryStore();
    const id = await seedDue(store, { status: APPLYING });
    let applyCalled = false;
    const ex: ApplyExecutor = {
      replan: async (r) => ({ diff: r.pinnedDiff!, digest: r.planDigest! }),
      apply: async () => {
        applyCalled = true;
        return { ok: true, detail: 'x' };
      },
      revert: async () => ({ ok: true, detail: 'x' }),
    };
    const outcomes = await runDueApplies(store, PROJECT, NOW, ex, {});
    expect(applyCalled).toBe(false); // an already-claimed row is never re-applied
    expect(outcomes).toEqual([{ requestId: id, result: 'skipped-moved' }]);
    expect((await getReq(store, id)).status).toBe(APPLYING); // untouched
  });
});
