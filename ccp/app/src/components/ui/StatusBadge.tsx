import type { JSX } from 'react';
import type { RequestStatus } from '@/types';
import './ui.css';

export interface StatusBadgeProps {
  status: RequestStatus;
}

/** Tone → which token drives the dot. Risk hues reused as neutral state signals. */
type StatusTone = 'done' | 'fail' | 'wait' | 'flight' | 'idle';

interface StatusSpec {
  tone: StatusTone;
  label: string;
}

const STATUS_SPEC: Record<RequestStatus, StatusSpec> = {
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

/**
 * Request lifecycle chip: an 8px dot + label. The dot carries the tone —
 * APPLIED/NOOP low, failures/REJECTED high, awaiting/changes med, in-flight
 * info, draft/withdrawn muted — so status never blurs into the Risk axis.
 */
export function StatusBadge({ status }: StatusBadgeProps): JSX.Element {
  const spec = STATUS_SPEC[status];
  return (
    <span className={`status-badge status-badge--${spec.tone}`} title={status}>
      <span className="status-badge__dot" aria-hidden="true" />
      {spec.label}
    </span>
  );
}
