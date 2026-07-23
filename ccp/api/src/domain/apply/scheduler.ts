import type { ConfigStore, TransactWrite } from '../../store/configStore';
import { ConditionError } from '../../store/configStore';
import type { ChainHeadItem, RequestItem } from '../../store/schema';
import { chainHead, requestCollectionGsi, requestKey } from '../../store/schema';
import { ApiError } from '../../errors';
import type { AuditEntryInput } from '../audit';
import { record, recordIn } from '../audit';
import { isFrozen } from '../config';
import { evaluateTime } from '../schedule';
import { digestOf, type ApplyExecutor, type ApplyResult } from './executor';
import { nullNotifier, type NotificationKind, type Notifier } from './notify';

/**
 * 0038 T3 — the DRY-RUN scheduled auto-apply scheduler. The intent (locked with the
 * operator): a change humans ALREADY approved through the two-level L2→L3 review and
 * scheduled for a maintenance window should be auto-applied at that window by this
 * server-side worker — but ONLY the exact reviewed change, and ONLY if nothing drifted.
 *
 * `runDueApplies` is PURE in the sense that matters: it takes `now` as a PARAMETER
 * (never reads the clock) and derives every timestamp from it, so every path is a
 * deterministic table test. It reads/writes the store (like `domain/schedule.ts#
 * settleWindow`, whose guarded-transact + audit-fold + idempotent-reread it mirrors),
 * and it drives the {@link ApplyExecutor} SEAM — the only executor that ships is the
 * DryRunExecutor, so NOTHING here runs terraform or touches AWS.
 *
 * SINGLE-APPLY GUARANTEE (adversarial review Finding 1): a real `executor.apply` can
 * exceed the loop interval, so a later tick can fire while an earlier one is still
 * inside `apply`. To make double-apply IMPOSSIBLE, a request is CLAIMED first — a
 * guarded `AWAITING_DEPLOY_APPROVAL → APPLYING` transition — BEFORE `apply` is called.
 * Only the worker that wins that `ifEquals` transact proceeds to `apply`; any concurrent
 * worker loses the claim and reports `skipped-moved` without applying. The loop
 * (`./loop.ts`) additionally refuses to start a new tick while the previous one is still
 * in flight. Off by default: no loop runs unless `CCP_SCHEDULER=1`.
 */

/** Every audit entry this module writes is attributed to the server-side worker. */
export const SCHEDULER_ACTOR = 'system:scheduler';

/** The claimed, apply-in-progress status. A row here has been taken by exactly one worker. */
export const APPLYING = 'APPLYING';
const AWAITING = 'AWAITING_DEPLOY_APPROVAL';

/**
 * Held statuses (clearly-named, tighten-only). A halted request LEAVES the auto-apply-
 * eligible state and demands a human — strictly MORE restrictive, never a weakening:
 *  - HALTED_DRIFT: the reviewed change can no longer be trusted (missing/corrupt pin,
 *    quorum shortfall, or a re-plan that drifted) → route to a FRESH plan/review.
 *  - HALTED_APPLY_FAILED: the apply itself failed after one retry → a human is alerted.
 */
export const HALTED_DRIFT = 'HALTED_DRIFT';
export const HALTED_APPLY_FAILED = 'HALTED_APPLY_FAILED';

export type HaltReason = 'NO_PINNED_PLAN' | 'QUORUM_LOST' | 'DRIFT' | 'APPLY_FAILED';

export interface ApplyOutcome {
  requestId: string;
  result: 'applied' | 'halted' | 'skipped-frozen' | 'skipped-moved';
  haltReason?: HaltReason;
}

export interface RunOptions {
  notifier?: Notifier;
  /** Master auto-apply freeze (from `CCP_APPLY_FROZEN`). true → audited no-op. */
  frozen?: boolean;
  /** OPT-IN and OFF by default: on apply-failure-after-retry, call `executor.revert` (dry-run). */
  revertOnFailure?: boolean;
  /** Test seam: deterministic audit ulids. Omit in production. */
  idFn?: () => string;
}

/* ── pure predicates ─────────────────────────────────────────────────────────── */

/**
 * Is the request's pinned reviewed plan present AND intact? Requires BOTH `pinnedDiff`
 * and `planDigest` to be NON-EMPTY strings, and the digest to be self-consistent with
 * the diff — a corrupt/tampered pin (digest ≠ sha256(diff)) or an empty pin is NOT
 * intact, so it can never reach `apply`. (Finding 3: empty `pinnedDiff` is rejected too.)
 */
export function isPinIntact(req: Pick<RequestItem, 'pinnedDiff' | 'planDigest'>): boolean {
  return (
    typeof req.pinnedDiff === 'string' &&
    req.pinnedDiff.length > 0 &&
    typeof req.planDigest === 'string' &&
    req.planDigest.length > 0 &&
    digestOf(req.pinnedDiff) === req.planDigest
  );
}

/** Windowed + currently open per the authoritative windowcheck port (`at <= now < endAt`). */
function windowOpen(req: Pick<RequestItem, 'schedule'>, now: number): boolean {
  return req.schedule.kind === 'window' && evaluateTime(req.schedule, undefined, now).verdict === 'IN_WINDOW';
}

/**
 * Is this request CLAIMABLE for auto-apply as of `now`? ONLY a fully-approved windowed
 * request in AWAITING_DEPLOY_APPROVAL whose window is currently open. An APPLYING row is
 * NOT claimable (it is already owned) — `runDueApplies` handles those separately.
 */
export function isDue(req: Pick<RequestItem, 'status' | 'schedule'>, now: number): boolean {
  return req.status === AWAITING && windowOpen(req, now);
}

/* ── halt specs ──────────────────────────────────────────────────────────────── */

interface HaltSpec {
  status: string;
  action: string;
  eventType: string;
  notifyKind: NotificationKind;
  message: string;
}

const HALT_SPECS: Record<HaltReason, HaltSpec> = {
  NO_PINNED_PLAN: {
    status: HALTED_DRIFT,
    action: 'scheduler-halt-noplan',
    eventType: 'halted',
    notifyKind: 'halted-no-plan',
    message: 'Pinned plan missing or corrupt — halted; routed to a fresh plan/review',
  },
  QUORUM_LOST: {
    status: HALTED_DRIFT,
    action: 'scheduler-halt-quorum',
    eventType: 'halted',
    notifyKind: 'halted-quorum',
    message: 'Approval quorum no longer met — halted; routed to a fresh review',
  },
  DRIFT: {
    status: HALTED_DRIFT,
    action: 'scheduler-halt-drift',
    eventType: 'halted',
    notifyKind: 'halted-drift',
    message: 'Re-plan drifted from the reviewed change — halted; routed to a fresh plan/review',
  },
  APPLY_FAILED: {
    status: HALTED_APPLY_FAILED,
    action: 'scheduler-apply-failed',
    eventType: 'apply_failed',
    notifyKind: 'apply-failed',
    message: 'Apply failed after one retry — halted; a human has been alerted',
  },
};

/* ── the scheduler core ──────────────────────────────────────────────────────── */

/**
 * Find every due request in `projectId` and run each through the decision logic.
 * FREEZE is checked BEFORE any apply — the master switch (`opts.frozen`) OR the project
 * change-freeze (`freeze.global`) makes this an AUDITED no-op that applies nothing.
 */
export async function runDueApplies(
  store: ConfigStore,
  projectId: string,
  now: number,
  executor: ApplyExecutor,
  opts: RunOptions = {},
): Promise<ApplyOutcome[]> {
  const nowIsoStr = new Date(now).toISOString();
  const notifier = opts.notifier ?? nullNotifier;

  const all = (await store.queryGSI1(requestCollectionGsi(projectId))) as RequestItem[];
  // The due set is windowed + in-window requests that are either CLAIMABLE
  // (AWAITING_DEPLOY_APPROVAL) OR already APPLYING. An APPLYING row is included ONLY so
  // an overlapping worker deterministically reports `skipped-moved` (it is already
  // claimed — see the claim guard in `processOne`) instead of silently ignoring it.
  const due = all.filter((r) => windowOpen(r, now) && (r.status === AWAITING || r.status === APPLYING));
  if (due.length === 0) return []; // nothing due → no work, no audit (avoids per-tick spam)

  // FREEZE — before ANY apply. Either the env master switch or the project change-freeze
  // halts every auto-apply instantly; we record ONE audited no-op (not per-request, to
  // bound audit growth while frozen) and touch no request.
  const frozen = opts.frozen === true || (await isFrozen(store, projectId));
  if (frozen) {
    await recordSchedulerAudit(
      store,
      projectId,
      {
        action: 'scheduler-frozen',
        actor: SCHEDULER_ACTOR,
        targetType: 'scheduler',
        targetId: projectId,
        before: { due: due.length },
        after: { applied: 0, frozen: true },
      },
      nowIsoStr,
      opts.idFn,
    );
    for (const r of due) {
      await notifier.notify({ kind: 'frozen', projectId, requestId: r.id, message: 'auto-apply frozen — held, not applied', at: nowIsoStr });
    }
    return due.map((r) => ({ requestId: r.id, result: 'skipped-frozen' }));
  }

  // Sequential (not Promise.all): concurrent transacts against the SAME per-project
  // chain head would only self-contend — the exact reasoning `routes/requests.ts`'s
  // list-settle loop documents.
  const outcomes: ApplyOutcome[] = [];
  for (const req of due) {
    if (req.status === APPLYING) {
      // Already claimed by a (possibly still-running or crashed) worker — NEVER re-apply.
      // The claim's `ifEquals` guard would reject a re-claim anyway; short-circuiting
      // here avoids a wasted re-plan for a row we can't touch.
      outcomes.push({ requestId: req.id, result: 'skipped-moved' });
      continue;
    }
    outcomes.push(await processOne(store, projectId, now, req, executor, opts));
  }
  return outcomes;
}

async function processOne(
  store: ConfigStore,
  projectId: string,
  now: number,
  req: RequestItem,
  executor: ApplyExecutor,
  opts: RunOptions,
): Promise<ApplyOutcome> {
  const nowIsoStr = new Date(now).toISOString();
  const notifier = opts.notifier ?? nullNotifier;

  // READ-ONLY GUARDS (on the snapshot) — halt from AWAITING_DEPLOY_APPROVAL, never claim.
  //
  // GUARD 1 — pinned plan present & intact. Absent/corrupt → HALT, never apply.
  if (!isPinIntact(req)) return halt(store, projectId, req, 'NO_PINNED_PLAN', AWAITING, nowIsoStr, opts);

  // GUARD 2 — defense-in-depth: still fully approved. AWAITING_DEPLOY_APPROVAL already
  // implies a completed ladder, but never apply a request short of its own quorum.
  if (req.approvals.length < req.approvalsRequired) return halt(store, projectId, req, 'QUORUM_LOST', AWAITING, nowIsoStr, opts);

  // RE-PLAN — compare to the approved plan by DIGEST. Only an exact match (the reviewed
  // change, nothing else) may proceed; any drift HALTS to a fresh plan/review. Re-plan is
  // read-only, so an overlapping worker doing it twice is wasteful but harmless.
  const replan = await executor.replan(req);
  if (replan.digest !== req.planDigest) return halt(store, projectId, req, 'DRIFT', AWAITING, nowIsoStr, opts);

  // CLAIM — the atomic single-apply gate AND the start-of-apply marker (Finding 1). Flip
  // AWAITING_DEPLOY_APPROVAL → APPLYING under an `ifEquals` guard: exactly one worker can
  // win, so exactly one worker can ever run `executor.apply` for this row. A concurrent /
  // overlapping worker loses the claim, reports `skipped-moved`, and does NOT apply.
  // Label honestly per executor: '[dry-run]' means no terraform ran; '[terraform]'
  // means the real executor is about to enact the approved planfile.
  const kindTag = executor.kind !== undefined ? ` [${executor.kind}]` : '';
  const startEvent = { at: nowIsoStr, type: 'apply_started', label: `Auto-apply started${kindTag} — claimed for apply`, actor: SCHEDULER_ACTOR };
  const startEntry: AuditEntryInput = {
    action: 'scheduler-apply-start',
    actor: SCHEDULER_ACTOR,
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: req.status },
    after: { status: APPLYING },
  };
  const claim = await writeStatusWithAudit(store, projectId, req, APPLYING, {}, startEvent, startEntry, AWAITING, nowIsoStr, opts.idFn);
  if (!claim.committed || !claim.fresh) return { requestId: req.id, result: 'skipped-moved' }; // lost the claim
  const claimed = claim.fresh; // status APPLYING, owned by THIS worker
  await notifier.notify({ kind: 'apply-started', projectId, requestId: req.id, message: `auto-apply attempt for ${req.targetAddress}`, at: nowIsoStr });

  // APPLY — retry ONCE, then HALT (from APPLYING).
  let res = await tryApply(executor, claimed);
  if (!res.ok) res = await tryApply(executor, claimed); // one retry
  if (!res.ok) {
    if (opts.revertOnFailure) {
      // OPT-IN and OFF by default: a dry-run revert. It never un-halts — a half-applied
      // change that auto-reverts can end up worse, so the request still lands HALTED.
      const rev = await executor.revert(claimed);
      await recordSchedulerAudit(
        store,
        projectId,
        { action: 'scheduler-revert', actor: SCHEDULER_ACTOR, targetType: 'request', targetId: req.id, requestId: req.id, before: { status: APPLYING }, after: { reverted: rev.ok } },
        nowIsoStr,
        opts.idFn,
      );
      await notifier.notify({ kind: 'reverted', projectId, requestId: req.id, message: `dry-run revert attempted: ${rev.detail}`, at: nowIsoStr });
    }
    return halt(store, projectId, claimed, 'APPLY_FAILED', APPLYING, nowIsoStr, opts);
  }

  // SUCCESS — status APPLYING → APPLIED. The executor's own detail carries the truth
  // of WHAT ran ("DRY-RUN — would apply …" vs a real terraform apply result), and the
  // audit stamps `dryRun` from the result so the two can never be conflated.
  const event = { at: nowIsoStr, type: 'applied', label: `Auto-apply${kindTag} — ${res.detail}`, actor: SCHEDULER_ACTOR };
  const entry: AuditEntryInput = {
    action: 'scheduler-applied',
    actor: SCHEDULER_ACTOR,
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: APPLYING },
    after: { status: 'APPLIED', dryRun: res.dryRun === true },
  };
  const extraSet: Record<string, unknown> = {};
  if (res.appliedSha !== undefined) extraSet.appliedSha = res.appliedSha;
  if (res.evidenceUrl !== undefined) extraSet.evidenceUrl = res.evidenceUrl;

  const done = await writeStatusWithAudit(store, projectId, claimed, 'APPLIED', extraSet, event, entry, APPLYING, nowIsoStr, opts.idFn);
  if (!done.committed) return { requestId: req.id, result: 'skipped-moved' };
  await notifier.notify({ kind: 'applied', projectId, requestId: req.id, message: `applied: ${res.detail}`, at: nowIsoStr });
  return { requestId: req.id, result: 'applied' };
}

/** Run a single apply attempt, normalizing a thrown error into `{ ok:false }`. */
async function tryApply(executor: ApplyExecutor, req: RequestItem): Promise<ApplyResult> {
  try {
    return await executor.apply(req);
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

async function halt(store: ConfigStore, projectId: string, req: RequestItem, reason: HaltReason, fromStatus: string, nowIsoStr: string, opts: RunOptions): Promise<ApplyOutcome> {
  const notifier = opts.notifier ?? nullNotifier;
  const spec = HALT_SPECS[reason];
  const event = { at: nowIsoStr, type: spec.eventType, label: spec.message, actor: SCHEDULER_ACTOR };
  const entry: AuditEntryInput = {
    action: spec.action,
    actor: SCHEDULER_ACTOR,
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: req.status },
    after: { status: spec.status, reason },
  };
  const { committed } = await writeStatusWithAudit(store, projectId, req, spec.status, {}, event, entry, fromStatus, nowIsoStr, opts.idFn);
  if (!committed) return { requestId: req.id, result: 'skipped-moved' };
  await notifier.notify({ kind: spec.notifyKind, projectId, requestId: req.id, message: spec.message, at: nowIsoStr });
  return { requestId: req.id, result: 'halted', haltReason: reason };
}

/* ── store writes (mirror domain/schedule.ts#settleWindow exactly) ───────────── */

/**
 * Guarded status write folded with a hash-chained audit append, in ONE transact. The
 * `ifEquals status = fromStatus` guard means a concurrent claim/cancel/rewindow/settle
 * never gets clobbered: on a lost guard we re-read and report the row's TRUE current
 * state (idempotent-safe), never erroring — identical to `settleWindow`. This is the
 * exact mechanism that makes the claim (`fromStatus = AWAITING_DEPLOY_APPROVAL`) a
 * single-winner gate, and the apply outcome (`fromStatus = APPLYING`) tamper-safe.
 */
async function writeStatusWithAudit(
  store: ConfigStore,
  projectId: string,
  req: RequestItem,
  targetStatus: string,
  extraSet: Record<string, unknown>,
  event: { at: string; type: string; label: string; actor: string },
  entry: AuditEntryInput,
  fromStatus: string,
  nowIsoStr: string,
  idFn?: () => string,
): Promise<{ committed: boolean; fresh: RequestItem | null }> {
  const k = requestKey(projectId, req.id);
  const hKey = chainHead(projectId);
  const events = [...req.events, event];
  const recordOpts = { nowFn: () => nowIsoStr, ...(idFn ? { idFn } : {}) };

  for (let attempt = 0; attempt < 2; attempt++) {
    const head = (await store.get(hKey.PK, hKey.SK)) as ChainHeadItem | null;
    const { writes } = recordIn(projectId, head, entry, recordOpts);
    const domain: TransactWrite[] = [
      {
        kind: 'update',
        pk: k.PK,
        sk: k.SK,
        set: { status: targetStatus, updatedAt: nowIsoStr, events, ...extraSet },
        ifEquals: { attr: 'status', value: fromStatus },
      },
    ];
    try {
      await store.transact([...domain, ...writes]);
      return { committed: true, fresh: { ...req, status: targetStatus, updatedAt: nowIsoStr, events, ...extraSet } };
    } catch (e) {
      if (e instanceof ConditionError) {
        const fresh = (await store.get(k.PK, k.SK)) as RequestItem | null;
        if (fresh && fresh.status !== fromStatus) return { committed: false, fresh }; // claimed/moved by someone else
        if (attempt === 0) continue; // chain contention (a DIFFERENT request's write) → retry once
        throw new ApiError('CHAIN_CONTENTION');
      }
      throw e;
    }
  }
  throw new ApiError('CHAIN_CONTENTION');
}

/** Standalone hash-chained append (frozen / revert markers) under the scheduler actor. */
async function recordSchedulerAudit(store: ConfigStore, projectId: string, entry: AuditEntryInput, nowIsoStr: string, idFn?: () => string): Promise<void> {
  await record(store, projectId, entry, { nowFn: () => nowIsoStr, ...(idFn ? { idFn } : {}) });
}
