/**
 * ARCH-7 — the request-status vocabulary, as ONE closed set.
 *
 * It was an unowned contract that had drifted in both directions. The server stored
 * status as free text (`z.string()`); the SPA declared a 21-value union. The scheduler
 * writes `HALTED_DRIFT`/`HALTED_APPLY_FAILED`, which appeared nowhere in `ccp/app/src` —
 * so the client rendered statuses it could not type. Meanwhile the union carried ~10
 * statuses the api never writes. All of it was recorded as a known tension in
 * `DOMAIN-MODEL.md` and left there while new statuses kept accreting.
 *
 * The cost was not the type: it was that every downstream filter over statuses had to be
 * hand-audited against a vocabulary that existed nowhere as a closed set. The submit rate
 * limiter's occupancy list is the worked example — see {@link occupiesQuotaSlot}.
 *
 * This module is dependency-free on purpose: `ccp/api` imports it through the `@app-lib`
 * alias (ARCH-6's seam), and a value import that dragged in zod would collapse the api's
 * types to `unknown` in CI.
 */

/**
 * Every status either side may produce or render. Closed, and the single source of truth
 * for {@link RequestStatus}.
 *
 * Some entries are still **client-only vocabulary** the api has never written
 * (`GENERATING`, `CHECKS_RUNNING`, `PLAN_READY`, `CODE_APPROVED`, `MERGED`, `NOOP`,
 * `DIGEST_MISMATCH`, `WITHDRAWN`, `DRAFT`, `SUBMITTED`). They are kept rather than pruned
 * because the SPA's ordering and labelling tables index by them; removing them is a
 * product decision about what the pipeline view promises, not a typing cleanup. What has
 * changed is that they are now in a list something can be checked against.
 */
export const REQUEST_STATUSES = [
  'DRAFT',
  'SUBMITTED',
  'GENERATING',
  'CHECKS_RUNNING',
  'PLAN_READY',
  'AWAITING_CODE_REVIEW',
  'CHANGES_REQUESTED',
  'CODE_APPROVED',
  'MERGED',
  'AWAITING_DEPLOY_APPROVAL',
  'APPLYING',
  'APPLIED',
  'NOOP',
  'APPLY_FAILED',
  'DIGEST_MISMATCH',
  'REJECTED',
  'NEEDS_ENGINEER',
  'WITHDRAWN',
  /**
   * Interim-profile cooling-off (api-mode only — the mock has no cooling state machine
   * and never produces this). Interim quorum (fewer eligible approvers than required) was
   * met, but the change does not go live until `earliestApplyAt`; settles LAZILY to
   * APPLIED or AWAITING_DEPLOY_APPROVAL server-side on the next read/mutation (no
   * background timer). Cancellable during the window via POST /requests/:id/cancel.
   */
  'APPROVED_COOLING',
  /** Cancelled during the APPROVED_COOLING window, or during/after a maintenance window
   * (api-mode only) — by the requester or a Lead/admin. */
  'CANCELLED',
  /**
   * (api-mode only.) A maintenance window closed with no apply, either lazily (the next
   * read after `windowEndOf(schedule)` passes — no background timer) or eagerly at
   * quorum-met when already infeasible. **Parked, not terminal**: exits are
   * POST /requests/:id/rewindow and POST /requests/:id/cancel.
   */
  'WINDOW_EXPIRED',
  /**
   * The scheduler halted the request because the reviewed change can no longer be trusted
   * — a CORRUPT plan pin, a quorum shortfall, or a re-plan that drifted. Demands a human
   * and a fresh plan/review. Exits via POST /requests/:id/cancel.
   *
   * The api has written this since the scheduler shipped; the client could not type it.
   */
  'HALTED_DRIFT',
  /**
   * The scheduler halted the request because the apply itself failed after one retry, or
   * because its claim lease expired with the worker gone. A human is alerted. Exits via
   * POST /requests/:id/cancel.
   *
   * The api has written this since the scheduler shipped; the client could not type it.
   */
  'HALTED_APPLY_FAILED',
] as const;

export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const KNOWN: ReadonlySet<string> = new Set(REQUEST_STATUSES);

/** Is this string one of the statuses either side is allowed to produce? */
export function isKnownRequestStatus(s: string): s is RequestStatus {
  return KNOWN.has(s);
}

/**
 * Statuses that RELEASE a requester's `maxOpen` quota slot — the request is done and
 * nobody is waiting on it.
 *
 * This is the small list on purpose, because {@link occupiesQuotaSlot} is its complement
 * and that direction fails CLOSED. The rate limiter used to hold the *other* list, five
 * statuses enumerated by hand, and the vocabulary grew underneath it: `APPLYING` and both
 * halt statuses arrived with the scheduler, `WINDOW_EXPIRED` with maintenance windows, and
 * none of them was added. All four are non-terminal — an `APPLYING` row is mid-apply, a
 * halted row is waiting on a human, a `WINDOW_EXPIRED` row is parked with two exits — and
 * every one of them silently released the slot. A requester could hold unbounded open work
 * by letting requests halt or park.
 *
 * Inverting it means the next status added to this vocabulary occupies a slot until
 * someone decides otherwise, rather than being invisible to the limiter until someone
 * notices. That is the difference between forgetting to add a status here and forgetting
 * to add one there.
 */
export const TERMINAL_STATUSES: ReadonlySet<RequestStatus> = new Set<RequestStatus>([
  'APPLIED',
  'NOOP',
  'REJECTED',
  'CANCELLED',
  'WITHDRAWN',
  'DRAFT', // never submitted — it was never in anybody's queue
]);

/** Does a request in this status still consume its requester's `maxOpen` quota? */
export function occupiesQuotaSlot(status: string): boolean {
  return !TERMINAL_STATUSES.has(status as RequestStatus);
}
