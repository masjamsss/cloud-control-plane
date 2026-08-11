import type { ConfigStore, TransactWrite } from '../../store/configStore';
import { ConditionError } from '../../store/configStore';
import type { ChainHeadItem, RequestItem } from '../../store/schema';
import { chainHead, requestCollectionGsi, requestKey } from '../../store/schema';
import { ApiError } from '../../errors';
import type { AuditEntryInput } from '../audit';
import { record, recordIn } from '../audit';
import { isFrozen } from '../config';
import { evaluateTime } from '../schedule';
import { bundleClaimLive } from '../bundleClaim';
import { digestOf, type ApplyExecutor, type ApplyResult } from './executor';
import type { DueCandidateSource } from './dueIndex';
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
 *
 * NO STATE THIS MODULE WRITES IS A DEAD END (API-2/API-3). That is a property, not a
 * coincidence, and it has three parts:
 *
 *  - `APPLYING` is LEASED, not owned forever. The claim stamps `applyClaimedAt`, and a
 *    claim past {@link APPLY_LEASE_MS} is halted by a later tick — automatically, with no
 *    operator verb to remember. The single-apply guarantee is unaffected: the sweep never
 *    re-applies, it only releases.
 *  - `HALTED_DRIFT`/`HALTED_APPLY_FAILED` are reachable by `POST /requests/:id/cancel`
 *    (`routes/requests.ts#CANCELLABLE_STATUSES`). They still demand a human — that is the
 *    point of a halt — but the human now has a verb.
 *  - A request with NO plan pin is HELD in `AWAITING_DEPLOY_APPROVAL`, never halted. See
 *    {@link PinState}: an absent pin is a deployment without a pin-writer, and destroying
 *    the request over it is not a safety property, it is data loss.
 */

/** Every audit entry this module writes is attributed to the server-side worker. */
export const SCHEDULER_ACTOR = 'system:scheduler';

/** The claimed, apply-in-progress status. A row here has been taken by exactly one worker. */
export const APPLYING = 'APPLYING';
const AWAITING = 'AWAITING_DEPLOY_APPROVAL';

/**
 * Held statuses (clearly-named, tighten-only). A halted request LEAVES the auto-apply-
 * eligible state and demands a human — strictly MORE restrictive, never a weakening:
 *  - HALTED_DRIFT: the reviewed change can no longer be trusted (CORRUPT pin, quorum
 *    shortfall, or a re-plan that drifted) → route to a FRESH plan/review. A pin that was
 *    never written is NOT this case — see {@link PinState}.
 *  - HALTED_APPLY_FAILED: the apply itself failed after one retry, or its claim lease
 *    expired with the worker gone → a human is alerted.
 *
 * Both are exited by CANCEL, and deliberately only by cancel: re-windowing a halted row
 * would re-arm the exact plan the halt refused. The way forward from a halt is a fresh
 * request through the humans.
 */
export const HALTED_DRIFT = 'HALTED_DRIFT';
export const HALTED_APPLY_FAILED = 'HALTED_APPLY_FAILED';

export type HaltReason = 'NO_PINNED_PLAN' | 'QUORUM_LOST' | 'DRIFT' | 'APPLY_FAILED' | 'APPLY_LEASE_EXPIRED';

export interface ApplyOutcome {
  requestId: string;
  /**
   * Every way one request can end a tick. `replan-failed` and `errored` are ERR-6's:
   * before them, a throwing `executor.replan` (or any other unexpected throw) escaped
   * `processOne`, escaped `runDueApplies` — taking every LATER due request in the
   * project with it — and was swallowed by `loop.ts`'s per-project `console.error`. A
   * failure with no outcome to report is a failure nothing can act on.
   */
  result: 'applied' | 'halted' | 'skipped-frozen' | 'skipped-moved' | 'held-no-plan' | 'replan-failed' | 'errored';
  haltReason?: HaltReason;
  /** The failure text for `replan-failed` / `errored`. Absent on every other result. */
  detail?: string;
}

/**
 * How long a worker may own an `APPLYING` claim before the scheduler treats it as dead
 * (API-2). The claim is stamped with `applyClaimedAt` and NOTHING else ever writes an
 * `APPLYING` row, so before this existed a worker that died between the claim and the
 * outcome write left the request in `APPLYING` FOREVER: not cancellable, not
 * re-windowable, not re-appliable, and not even visible to a later tick (which
 * short-circuits every `APPLYING` row as `skipped-moved`).
 *
 * Deliberately far longer than any single apply — the bundle's own longest step timeout
 * is 15 minutes and `loop.ts` refuses to overlap ticks — so a LIVE worker is never
 * robbed of a claim it is still working. An hour of no progress on a single-process
 * server means the process died, not that the apply is slow.
 */
export const APPLY_LEASE_MS = 60 * 60_000;

/**
 * Has this `APPLYING` row's claim outlived its lease as of `now`? `applyClaimedAt` is
 * stamped by the claim; `updatedAt` is the fallback for a row claimed by a build that
 * predates the stamp (the claim has always written `updatedAt`), so rows ALREADY wedged
 * when this shipped recover too. A non-finite timestamp counts as expired: a row that
 * cannot be aged is one nothing can ever release, which is the exact wedge being fixed.
 */
export function applyClaimExpired(req: Pick<RequestItem, 'applyClaimedAt' | 'updatedAt'>, now: number): boolean {
  const claimedMs = Date.parse(req.applyClaimedAt ?? req.updatedAt);
  if (!Number.isFinite(claimedMs)) return true;
  return now - claimedMs >= APPLY_LEASE_MS;
}

/**
 * CONC-10 — {@link settleApplyClaim}'s precondition, hoisted into a cheap SYNCHRONOUS
 * predicate so a list read can decide whether to call the settler at all. Same shape as
 * `domain/schedule.ts#needsWindowSettlement`, and for the same reason: a list endpoint
 * settles every row it returns, but on any real corpus almost none of them need it.
 *
 * It is the settler's literal guard, not a second copy of the rule — `settleApplyClaim`
 * calls THIS — so the screen and the settler cannot disagree about which rows need work.
 */
export function needsApplyClaimSettlement(
  req: Pick<RequestItem, 'status' | 'applyClaimedAt' | 'updatedAt'>,
  now: number,
): boolean {
  return req.status === APPLYING && applyClaimExpired(req, now);
}

export interface RunOptions {
  notifier?: Notifier;
  /** Master auto-apply freeze (from `CCP_APPLY_FROZEN`). true → audited no-op. */
  frozen?: boolean;
  /** OPT-IN and OFF by default: on apply-failure-after-retry, call `executor.revert` (dry-run). */
  revertOnFailure?: boolean;
  /**
   * PERF-14 — where the tick's candidate rows come from. Omitted, this reads the
   * project's whole request collection, which is what every existing caller does and what
   * every test that does not care about cost still exercises. The loop passes a
   * {@link ./dueIndex.RequestDueIndex}, whose per-tick cost tracks a project's OPEN work
   * rather than its history.
   *
   * It is an INPUT, not a hidden singleton, for the same reason `now` is: the tick stays a
   * deterministic function of what it is handed, and the indexed and unindexed paths can
   * be run side by side against the same store and compared (they are, in
   * `test/schedulerDueIndex.test.ts`).
   */
  candidates?: DueCandidateSource;
  /** Test seam: deterministic audit ulids. Omit in production. */
  idFn?: () => string;
}

/* ── pure predicates ─────────────────────────────────────────────────────────── */

/**
 * The three states a request's plan pin can be in, which are NOT interchangeable
 * (API-3):
 *
 *  - `intact`   — both fields present and `sha256(pinnedDiff) === planDigest`.
 *  - `corrupt`  — a pin EXISTS but does not hold up: only one of the pair is present,
 *                 or the digest does not match its diff. That is tamper/damage
 *                 evidence and must HALT.
 *  - `absent`   — neither field was ever written. Today that is EVERY request: the
 *                 schema's own comment says the pin is "written at approval time by a
 *                 LATER step" and no such step exists yet, so an absent pin means the
 *                 pin-writer is not deployed — an operator misconfiguration, not a
 *                 corrupted change. Halting on it destroyed every scheduled request the
 *                 moment `CCP_SCHEDULER=1` was set.
 *
 * Collapsing `absent` into `corrupt` is what made arming the documented feature
 * destructive; keeping them apart is what lets the scheduler HOLD instead of HALT.
 */
export type PinState = 'intact' | 'corrupt' | 'absent';

export function pinStateOf(req: Pick<RequestItem, 'pinnedDiff' | 'planDigest'>): PinState {
  const diff = typeof req.pinnedDiff === 'string' && req.pinnedDiff.length > 0 ? req.pinnedDiff : undefined;
  const digest = typeof req.planDigest === 'string' && req.planDigest.length > 0 ? req.planDigest : undefined;
  if (diff === undefined && digest === undefined) return 'absent';
  if (diff === undefined || digest === undefined) return 'corrupt';
  return digestOf(diff) === digest ? 'intact' : 'corrupt';
}

/**
 * Is the request's pinned reviewed plan present AND intact? Requires BOTH `pinnedDiff`
 * and `planDigest` to be NON-EMPTY strings, and the digest to be self-consistent with
 * the diff — a corrupt/tampered pin (digest ≠ sha256(diff)) or an empty pin is NOT
 * intact, so it can never reach `apply`. (Finding 3: empty `pinnedDiff` is rejected too.)
 */
export function isPinIntact(req: Pick<RequestItem, 'pinnedDiff' | 'planDigest'>): boolean {
  return pinStateOf(req) === 'intact';
}

/**
 * Windowed + currently open per the authoritative windowcheck port (`at <= now < endAt`)
 * AND past any cooling-off the row carries. `earliestApplyAt` used to be passed as
 * `undefined` here (API-7), so the compensating-control delay that every human-facing
 * read composes through `applyGate` was invisible to the ONE lane that applies without a
 * human present. `evaluateTime` already handles it — the verdict is `BEFORE_WINDOW`, not
 * `IN_WINDOW`, while cooling.
 */
function windowOpen(req: Pick<RequestItem, 'schedule' | 'earliestApplyAt'>, now: number): boolean {
  return req.schedule.kind === 'window' && evaluateTime(req.schedule, req.earliestApplyAt, now).verdict === 'IN_WINDOW';
}

/**
 * Is this request CLAIMABLE for auto-apply as of `now`? ONLY a fully-approved windowed
 * request in AWAITING_DEPLOY_APPROVAL whose window is currently open, and which the OTHER
 * apply lane is not already inside. An APPLYING row is NOT claimable (it is already
 * owned) — `runDueApplies` handles those separately.
 *
 * ARCH-4 — THE BUNDLE CHECK. The route-triggered bundle (`CCP_BUNDLE=1`) and this
 * timer-driven scheduler (`CCP_SCHEDULER=1`) are independent opt-ins with overlapping
 * domains, and nothing at arming time refuses the combination. Every bundle-eligible
 * approved request is windowed, i.e. sits in exactly the status this filter claims. The
 * bundle's claim writes `bundle.state:'running'` and deliberately does NOT move `status`,
 * so this filter — which read only status and window — could not see it.
 *
 * With both lanes armed, a Lead's bundle click inside an open window raced the next tick:
 * the scheduler claimed `AWAITING_DEPLOY_APPROVAL → APPLYING` and ran its executor while
 * the bundle was mid-clone/gate; the bundle then landed its commit and satisfied the CI
 * deploy gate, after which its own result write lost the `ifEquals status` guard and
 * surfaced as a 500 `CHAIN_CONTENTION` — real, irreversible side effects with a request
 * record stuck at `bundle.state:'running'`.
 *
 * The check is on the LEASE, not the bare flag ({@link bundleClaimLive}): a crashed
 * bundle must not wedge auto-apply forever, which would be ERR-2's defect one lane over.
 * It is deliberately a *skip*, not a halt — the bundle is a legitimate owner doing exactly
 * what it was asked to, and the next tick after it finishes (or after its lease lapses)
 * picks the row up normally.
 *
 * The reverse direction was already safe and stays that way by a different mechanism:
 * `APPLYING` is not in the route's `BUNDLE_ELIGIBLE` set, so a scheduler-claimed row
 * refuses the bundle with a 409.
 */
export function isDue(
  req: Pick<RequestItem, 'status' | 'schedule' | 'earliestApplyAt' | 'bundle'>,
  now: number,
): boolean {
  return req.status === AWAITING && !bundleClaimLive(req.bundle, now) && windowOpen(req, now);
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
  APPLY_LEASE_EXPIRED: {
    status: HALTED_APPLY_FAILED,
    action: 'scheduler-apply-lease-expired',
    eventType: 'apply_failed',
    notifyKind: 'apply-lease-expired',
    message: 'The worker that claimed this apply never reported back — claim lease expired; a human must confirm what landed',
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

  // The candidate rows for this tick. Both sources return a SUPERSET of what the two
  // filters below can select — every `APPLYING` row and every claimable row — so the
  // decisions are identical either way; only the cost differs (PERF-14).
  const all =
    opts.candidates !== undefined
      ? await opts.candidates.candidates(store, projectId)
      : ((await store.queryGSI1(requestCollectionGsi(projectId))) as RequestItem[]);

  // CLAIMED ROWS ARE SWEPT INDEPENDENTLY OF THE WINDOW (API-2). A worker that dies
  // mid-apply strands the row in `APPLYING`, and by the time anyone notices its window
  // has usually closed — so a window-filtered sweep would never look at exactly the rows
  // that are stuck. Every `APPLYING` row in the project is considered here, whatever its
  // schedule says.
  const claimed = all.filter((r) => r.status === APPLYING);

  // The due set is windowed + in-window requests that are CLAIMABLE
  // (AWAITING_DEPLOY_APPROVAL, no live bundle claim — see {@link isDue}). Calls the
  // exported predicate rather than restating it: this line WAS a copy of `isDue`'s body,
  // which is exactly how the one lane that matters could miss a rule the predicate gained.
  const due = all.filter((r) => isDue(r, now));

  const outcomes: ApplyOutcome[] = [];

  // LEASE SWEEP — runs BEFORE the freeze check and independently of it. It applies
  // nothing; it only releases rows whose owner is gone. A frozen deployment that still
  // accumulated unreleasable `APPLYING` rows would be the same permanent wedge with an
  // extra step, so the freeze must not gate the cleanup.
  for (const req of claimed) {
    if (!applyClaimExpired(req, now)) {
      // Owned by a (still-running) worker — NEVER re-apply. The claim's `ifEquals` guard
      // would reject a re-claim anyway; short-circuiting here avoids a wasted re-plan.
      outcomes.push({ requestId: req.id, result: 'skipped-moved' });
      continue;
    }
    // The lease is up. HALT rather than re-claim: the dead worker may have applied
    // some, all, or none of the change, and re-running an apply over a half-applied
    // change is the one outcome worse than stopping. `HALTED_APPLY_FAILED` is now an
    // exit, not a dead end — cancel accepts it (routes/requests.ts).
    outcomes.push(
      await perRequest(req, projectId, nowIsoStr, notifier, () =>
        halt(store, projectId, req, 'APPLY_LEASE_EXPIRED', APPLYING, nowIsoStr, opts),
      ),
    );
  }

  if (due.length === 0) return outcomes; // nothing due → no work, no audit (avoids per-tick spam)

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
    for (const r of due) outcomes.push({ requestId: r.id, result: 'skipped-frozen' });
    return outcomes;
  }

  // Sequential (not Promise.all): concurrent transacts against the SAME per-project
  // chain head would only self-contend — the exact reasoning `routes/requests.ts`'s
  // list-settle loop documents.
  //
  // ERR-6 — PER-REQUEST ISOLATION. Sequential must not mean "the first thrower ends
  // the tick". `processOne` reaches an executor, a store and a hash chain, every one of
  // which can throw; before this, one such throw aborted the whole loop, so a single
  // permanently-failing request silently starved every LATER due request in the project
  // of its maintenance window, every tick, with only a stdout line to say so.
  for (const req of due) {
    outcomes.push(
      await perRequest(req, projectId, nowIsoStr, notifier, () => processOne(store, projectId, now, req, executor, opts)),
    );
  }
  return outcomes;
}

/**
 * Run one request's work so that its failure is ITS failure: an unexpected throw becomes
 * an `errored` outcome for that request and the caller keeps going. Deliberately the
 * outermost wrapper and deliberately catch-all — the modelled failures (a refusing
 * executor, a lost claim, a re-plan that would not run) are handled inside `processOne`
 * with their own outcomes and never reach here, so anything that does IS unexpected and
 * the only safe thing to do with it is report it and move on.
 *
 * The notify is itself guarded: this is the error path, and a notifier that throws here
 * would re-create the exact collateral damage the wrapper exists to prevent.
 */
async function perRequest(
  req: RequestItem,
  projectId: string,
  nowIsoStr: string,
  notifier: Notifier,
  fn: () => Promise<ApplyOutcome>,
): Promise<ApplyOutcome> {
  try {
    return await fn();
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    try {
      await notifier.notify({
        kind: 'tick-error',
        projectId,
        requestId: req.id,
        message: `auto-apply tick failed for this request: ${detail}`,
        at: nowIsoStr,
      });
    } catch {
      /* a broken notifier must not take the tick down with it */
    }
    return { requestId: req.id, result: 'errored', detail };
  }
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
  // GUARD 1 — pinned plan present & intact. A CORRUPT pin halts (tamper/damage
  // evidence); an ABSENT pin HOLDS the request exactly where it is (API-3). Neither
  // ever applies.
  const pin = pinStateOf(req);
  if (pin === 'corrupt') return halt(store, projectId, req, 'NO_PINNED_PLAN', AWAITING, nowIsoStr, opts);
  if (pin === 'absent') return holdNoPlan(store, projectId, req, nowIsoStr, opts);

  // GUARD 2 — defense-in-depth: still fully approved. AWAITING_DEPLOY_APPROVAL already
  // implies a completed ladder, but never apply a request short of its own quorum.
  if (req.approvals.length < req.approvalsRequired) return halt(store, projectId, req, 'QUORUM_LOST', AWAITING, nowIsoStr, opts);

  // RE-PLAN — compare to the approved plan by DIGEST. Only an exact match (the reviewed
  // change, nothing else) may proceed; any drift HALTS to a fresh plan/review. Re-plan is
  // read-only, so an overlapping worker doing it twice is wasteful but harmless.
  //
  // A re-plan that THREW is not drift and is not a verdict about the change at all: it
  // is the executor saying "I could not look" (ERR-6). It gets its own modelled outcome
  // — see {@link holdReplanFailed} for why that is a HOLD and not a halt.
  const replan = await tryReplan(executor, req);
  if (!replan.ok) return holdReplanFailed(store, projectId, req, replan.detail, nowIsoStr, opts);
  if (replan.digest !== req.planDigest) return halt(store, projectId, req, 'DRIFT', AWAITING, nowIsoStr, opts);

  // CLAIM — the atomic single-apply gate AND the start-of-apply marker (Finding 1). Flip
  // AWAITING_DEPLOY_APPROVAL → APPLYING under an `ifEquals` guard: exactly one worker can
  // win, so exactly one worker can ever run `executor.apply` for this row. A concurrent /
  // overlapping worker loses the claim, reports `skipped-moved`, and does NOT apply.
  // Label honestly per executor: '[dry-run]' means no terraform ran; '[terraform]'
  // means the real executor is about to enact the approved planfile.
  // The claim is stamped with `applyClaimedAt` so a LATER tick can tell a live claim
  // from a dead one (API-2). Without it, `APPLYING` carried no age and the row could
  // only ever be read as "owned by someone", forever.
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
  const claim = await writeStatusWithAudit(store, projectId, req, APPLYING, { applyClaimedAt: nowIsoStr }, startEvent, startEntry, AWAITING, nowIsoStr, opts.idFn);
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

/**
 * Run the re-plan, normalizing a thrown error into a value — the same shape `tryApply`
 * has always had. `executor.apply` was wrapped from the start and `executor.replan` was
 * called bare (ERR-6), which is the whole defect: two calls to the same seam, one of
 * them modelled and one of them not.
 */
async function tryReplan(
  executor: ApplyExecutor,
  req: RequestItem,
): Promise<{ ok: true; digest: string } | { ok: false; detail: string }> {
  try {
    const { digest } = await executor.replan(req);
    return { ok: true, digest };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/** The timeline event a request carries while its re-plan cannot be run (ERR-6). */
export const REPLAN_FAILED_EVENT = 'apply_replan_failed';

/** How much of the executor's failure text reaches the timeline/audit. Bounded because
 * a terraform error can be pages long and this text is stored on the request row. */
const REPLAN_DETAIL_MAX = 300;

/**
 * HOLD on a re-plan that would not run (ERR-6) — the request stays exactly where it is,
 * `AWAITING_DEPLOY_APPROVAL`, still cancellable, still re-windowable, still bundle-
 * eligible, and the tick moves on to its siblings.
 *
 * WHY NOT HALT — the finding's own recommendation was "halt after N consecutive
 * failures (a new REPLAN_FAILED halt spec)". That is rejected deliberately, and it is
 * the same judgement API-3 already forced on this file (see {@link PinState}): a halt is
 * exited ONLY by cancel, so halting means "throw this approved change away and send two
 * humans back through the ladder". A re-plan failure is evidence about the EXECUTOR —
 * an unreachable backend, a registry blip, ERR-5's cached init rejection — not about the
 * change. Nothing has been applied, nothing is half-landed, and there is no damage to
 * record. `L-11`'s corollary states the rule: where the safe answer is "not now", HOLD
 * the row and say so in the timeline; save the terminal state for evidence of damage.
 *
 * AND THE RETRY IS ALREADY BOUNDED, which is the part the finding missed: a due request
 * is due only while its window is OPEN ({@link isDue} → `windowOpen`), so the retries
 * stop when the window closes and `domain/schedule.ts#settleWindow` stamps
 * `WINDOW_EXPIRED` on the next read — a parked state with two exits (rewindow, which
 * KEEPS the approvals, or cancel). A halt would replace that recoverable ending with an
 * unrecoverable one for a fault the request had no part in.
 *
 * What was actually missing is evidence, and that is what this writes: ONE timeline
 * event + audit entry + notification per failure EPISODE. The de-dup is "the last event
 * on the row is already this one" rather than "this event type appears anywhere", so a
 * failure that recurs after something else happened to the request (a rewindow, an
 * approval) is recorded again instead of being swallowed by a marker from last week —
 * while a re-plan that fails every tick for six hours still writes exactly once, and the
 * per-project chain head is not appended to every 60 seconds forever.
 */
async function holdReplanFailed(
  store: ConfigStore,
  projectId: string,
  req: RequestItem,
  detail: string,
  nowIsoStr: string,
  opts: RunOptions,
): Promise<ApplyOutcome> {
  const short = detail.length > REPLAN_DETAIL_MAX ? `${detail.slice(0, REPLAN_DETAIL_MAX)}…` : detail;
  if (req.events.at(-1)?.type === REPLAN_FAILED_EVENT) {
    return { requestId: req.id, result: 'replan-failed', detail }; // episode already recorded — no write, no audit
  }
  const message = `Auto-apply could not re-plan this change — holding it (not applying, not halting): ${short}`;
  const event = { at: nowIsoStr, type: REPLAN_FAILED_EVENT, label: message, actor: SCHEDULER_ACTOR };
  const entry: AuditEntryInput = {
    action: 'scheduler-replan-failed',
    actor: SCHEDULER_ACTOR,
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: req.status },
    after: { status: AWAITING, held: 'REPLAN_FAILED', detail: short },
  };
  // Same status in and out, guarded on the status this tick read — a concurrent
  // cancel/rewindow/settle is never clobbered.
  const { committed } = await writeStatusWithAudit(store, projectId, req, AWAITING, {}, event, entry, AWAITING, nowIsoStr, opts.idFn);
  if (!committed) return { requestId: req.id, result: 'skipped-moved' };
  const notifier = opts.notifier ?? nullNotifier;
  await notifier.notify({ kind: 'replan-failed', projectId, requestId: req.id, message, at: nowIsoStr });
  return { requestId: req.id, result: 'replan-failed', detail };
}

/** The one-time timeline event a held-for-no-pin request carries. */
export const HELD_NO_PLAN_EVENT = 'apply_held_no_plan';

/**
 * HOLD (API-3) — a request whose plan pin was never written stays exactly where it is:
 * `AWAITING_DEPLOY_APPROVAL`, still cancellable, still re-windowable, still bundle-
 * eligible. It is NOT halted, because nothing about the change is wrong; the deployment
 * simply has no pin-writer.
 *
 * The hold is recorded ONCE per request — an audited timeline event the requester and
 * the operator both see — and every later tick recognises that marker and writes
 * nothing. That is the whole reason this is not a silent skip (which would be its own
 * finding: an operator arms the documented feature, nothing happens, and no evidence
 * anywhere says why) and not a per-tick audit entry either (a minute-by-minute forever
 * loop against the per-project chain head).
 */
async function holdNoPlan(store: ConfigStore, projectId: string, req: RequestItem, nowIsoStr: string, opts: RunOptions): Promise<ApplyOutcome> {
  if (req.events.some((e) => e.type === HELD_NO_PLAN_EVENT)) {
    return { requestId: req.id, result: 'held-no-plan' }; // already recorded — no write, no audit
  }
  const message = 'No reviewed plan is pinned on this request — auto-apply is holding it, not applying and not halting';
  const event = { at: nowIsoStr, type: HELD_NO_PLAN_EVENT, label: message, actor: SCHEDULER_ACTOR };
  const entry: AuditEntryInput = {
    action: 'scheduler-hold-noplan',
    actor: SCHEDULER_ACTOR,
    targetType: 'request',
    targetId: req.id,
    requestId: req.id,
    before: { status: req.status },
    after: { status: AWAITING, held: 'NO_PINNED_PLAN' },
  };
  // Same status in and out: the write appends the event and nothing else, guarded on the
  // status this tick read so a concurrent cancel/rewindow/settle is never clobbered.
  const { committed } = await writeStatusWithAudit(store, projectId, req, AWAITING, {}, event, entry, AWAITING, nowIsoStr, opts.idFn);
  if (!committed) return { requestId: req.id, result: 'skipped-moved' };
  const notifier = opts.notifier ?? nullNotifier;
  await notifier.notify({ kind: 'held-no-plan', projectId, requestId: req.id, message, at: nowIsoStr });
  return { requestId: req.id, result: 'held-no-plan' };
}

/**
 * CONC-10 — SETTLE-ON-READ for an expired apply claim. Releases an `APPLYING` row whose
 * claim has outlived {@link APPLY_LEASE_MS} to `HALTED_APPLY_FAILED`, on the next READ of
 * that row, and returns the row's true current state (the settled row, the row someone
 * else moved first, or the row untouched). A no-op for anything that is not a lease-
 * expired `APPLYING` row — idempotent, and safe to call on every row of a list.
 *
 * WHY THIS EXISTS ON TOP OF THE TICK'S SWEEP. API-2 gave the claim a lease and taught
 * `runDueApplies` to halt an expired one, which closes the wedge — for as long as the
 * scheduler is armed. `runDueApplies` has exactly ONE production caller, the
 * `CCP_SCHEDULER=1` timer in `loop.ts`, so the release depended on the same subsystem
 * whose worker just died still being switched on. Disarming the scheduler after a crash
 * mid-apply is the obvious operator move, and it re-created the original dead end:
 * `APPLYING` is refused by approve, reject, rewindow, cancel and the bundle alike, so the
 * remedy was editing the store by hand — CONC-10 verbatim.
 *
 * Settling on read is the doctrine every other lease in this codebase already follows
 * (`settleCooling`, `settleWindow`, `settleScanJobLease`, `settlePendingExpiry`): no
 * background timer, no operator verb to remember, and the release happens on the next
 * read or the next tick, whichever comes first.
 *
 * It shares `halt()` with the sweep rather than re-deriving the transition, so the two
 * paths write the same status, the same timeline event and the same audit action by
 * construction. `now` is a PARAMETER, never a clock read — this module stays deterministic
 * and its callers pass the same `nowMs()` they screen with.
 *
 * The notifier defaults to the null one: the request timeline and the hash-chained audit
 * (the two channels this product actually has — see `notify.ts`) are both written either
 * way, and the injectable pager belongs to the loop that owns a notifier instance.
 */
export async function settleApplyClaim(
  store: ConfigStore,
  projectId: string,
  req: RequestItem,
  now: number,
  opts: RunOptions = {},
): Promise<RequestItem> {
  if (!needsApplyClaimSettlement(req, now)) return req;
  const k = requestKey(projectId, req.id);
  await halt(store, projectId, req, 'APPLY_LEASE_EXPIRED', APPLYING, new Date(now).toISOString(), opts);
  // Re-read rather than trust the write: a lost `ifEquals` guard means someone else moved
  // the row (a concurrent tick, a settle from another request), and the caller must see
  // what actually landed — the same idempotent-reread `settleWindow` performs.
  return ((await store.get(k.PK, k.SK)) as RequestItem | null) ?? req;
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
