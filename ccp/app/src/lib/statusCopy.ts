import type { RequestStatus } from '@/types';

/**
 * UI-10 — the ONE place request-status copy is curated. `lib/`, deliberately, not
 * `components/ui/StatusBadge.tsx`: `lib/palette.ts` (the command-palette hint text) needs
 * this mapping too, and `lib/` importing FROM `components/` would be the wrong direction —
 * a data layer pulling in a rendered component (and, transitively, its CSS side-effect
 * import). `StatusBadge` imports the tone/label pair FROM here instead.
 *
 * Before this file existed, three call sites each carried their own `humanizeStatus` — a
 * mechanical underscore-to-space transform — producing different words for the same state
 * right next to the badge: `AWAITING_CODE_REVIEW` badged "Awaiting review" but read
 * "Awaiting code review" in the filter dropdown a few pixels away. A fourth site
 * (`Notifications.ownNote`'s default branch) skipped the transform entirely and rendered
 * the raw enum, `· CHECKS_RUNNING`. `copyLint` cannot catch any of this — these are
 * derived strings, not literals — so nothing failed while it drifted.
 */

/** Tone → which token drives the dot. Risk hues reused as neutral state signals. */
export type StatusTone = 'done' | 'fail' | 'wait' | 'flight' | 'idle';

export interface StatusSpec {
  tone: StatusTone;
  label: string;
}

export const STATUS_SPEC: Record<RequestStatus, StatusSpec> = {
  DRAFT: { tone: 'idle', label: 'Draft' },
  SUBMITTED: { tone: 'flight', label: 'Submitted' },
  GENERATING: { tone: 'flight', label: 'Generating' },
  CHECKS_RUNNING: { tone: 'flight', label: 'Checks running' },
  PLAN_READY: { tone: 'flight', label: 'Plan ready' },
  AWAITING_CODE_REVIEW: { tone: 'wait', label: 'Awaiting review' },
  CHANGES_REQUESTED: { tone: 'wait', label: 'Changes requested' },
  CODE_APPROVED: { tone: 'flight', label: 'Code approved' },
  MERGED: { tone: 'flight', label: 'Merged' },
  AWAITING_DEPLOY_APPROVAL: { tone: 'wait', label: 'Awaiting deploy' },
  APPLYING: { tone: 'flight', label: 'Applying' },
  APPLIED: { tone: 'done', label: 'Applied' },
  NOOP: { tone: 'done', label: 'No change' },
  APPLY_FAILED: { tone: 'fail', label: 'Apply failed' },
  DIGEST_MISMATCH: { tone: 'fail', label: 'Digest mismatch' },
  REJECTED: { tone: 'fail', label: 'Rejected' },
  NEEDS_ENGINEER: { tone: 'flight', label: 'Needs engineer' },
  WITHDRAWN: { tone: 'idle', label: 'Withdrawn' },
  // Interim cooling-off (api-mode only): fully approved,
  // holding until earliestApplyAt — the same "waiting on something" tone as
  // AWAITING_DEPLOY_APPROVAL, not a failure.
  // ARCH-7: the scheduler has written both of these since it shipped, and this table —
  // an exhaustive Record over the union — could not have contained them, because the
  // union did not. A halted request is a hard stop that needs a human, not a wait:
  // `fail` tone, the same as APPLY_FAILED, which is what a halt usually follows.
  HALTED_DRIFT: { tone: 'fail', label: 'Halted — plan drifted' },
  HALTED_APPLY_FAILED: { tone: 'fail', label: 'Halted — apply failed' },
  APPROVED_COOLING: { tone: 'wait', label: 'Cooling off' },
  // A deliberate stop by the requester or a Lead/admin — same tone as
  // WITHDRAWN (self-initiated), not REJECTED (someone else refused it).
  CANCELLED: { tone: 'idle', label: 'Cancelled' },
  // (api-mode only): a maintenance window closed unapplied.
  // Parked, not a hard failure — but unlike AWAITING_DEPLOY_APPROVAL/
  // APPROVED_COOLING (both "on track, just waiting"), this needs a human to
  // rewindow or cancel, so it gets the same attention-grabbing tone as
  // APPLY_FAILED/DIGEST_MISMATCH/REJECTED rather than `wait`. (The concept
  // doc's own prose calls for a "blocked" tone; this codebase's StatusTone
  // union has no such value — `fail` is the closest existing bucket.)
  WINDOW_EXPIRED: { tone: 'fail', label: 'Window expired' },
};

/** The curated, human-readable label for a request status — never the raw enum. */
export function requestStatusLabel(status: RequestStatus): string {
  return STATUS_SPEC[status].label;
}
