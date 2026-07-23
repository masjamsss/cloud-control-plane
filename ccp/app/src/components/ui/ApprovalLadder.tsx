import type { JSX } from 'react';
import type { Approval, ApprovalStep, Schedule } from '@/types';
import { resolveName } from '@/lib/accounts';
import { formatProjectTime } from '@/lib/datetime';
import { buildLadderSegments, ladderAriaLabel, ladderRowTooltip } from '@/lib/approvalLadder';
import './approval-ladder.css';

export type ApprovalLadderSize = 'row' | 'card' | 'detail';

export interface ApprovalLadderProps {
  /** `request.approvalsRequired` — may be 0/undefined (an engineer-tier
   * request mid-fix elsewhere never having set a real requirement, or a
   * legacy row). The ladder renders a graceful "awaiting requirement" state
   * rather than breaking or reading as falsely complete — see
   * `lib/approvalLadder.ts#buildLadderSegments`. */
  required: number;
  approvals: Approval[];
  /** `request.nextApprovalStep` (api-mode only; absent in mock) — which
   * SENIORITY signs next. Undefined degrades to the same "Approval" label
   * `ladderStatusText` already falls back to; never a blank. */
  nextStep?: ApprovalStep | null;
  /** The window this applies in, if any — `kind:'now'`/absent renders no
   * schedule note. Always routed through `formatProjectTime`, never
   * `slice()` (F-04: a raw-UTC clock face read as local time). */
  schedule?: Schedule;
  /** The existing `mayApprove` computation: can THIS viewer sign the next
   * step right now? */
  viewerCanSign: boolean;
  /** SoD context for when `viewerCanSign` is false — is this the viewer's
   * OWN request? Names the reason instead of a silently disabled button. */
  viewerIsOwnRequest?: boolean;
  /** `'row'` — MyRequests' compact N/M pill + tooltip. `'card'` — the
   * approvals-queue footer's left slot, beside the Approve/Reject buttons.
   * `'detail'` — RequestDetail's full APPROVALS box. Defaults to `'card'`. */
  size?: ApprovalLadderSize;
}

/**
 * The shared approval-progress stepper (UX audit 2026-07-21, the
 * ApprovalsQueue deep-dive — F-03/F-04/S-08). One glance answers: how far
 * along (N of M, mono/tabular — the Ledger data-authority figure this
 * design keeps verbatim), WHO signed (a first-class name + timestamp, never
 * a parenthetical), WHAT KIND of signer is next (first/final approver when
 * the api provides it, a graceful "Approval" fallback in mock), WHEN it
 * applies (the project's local time, never a raw clock face), and whether
 * the viewer can act. Replaces: the queue's 12px mono debug string (F-03),
 * RequestDetail's plain N-of-M box, and MyRequests' bare count pill — three
 * unrelated renderings of the same concept (S-08) become this one component
 * in three sizes.
 *
 * Presentational only: every gate (who may actually click Approve) stays
 * exactly where it already lived (`lib/permissions.ts#canApprove` +
 * `canSignApprovalStep`, server-enforced) — this component only decides what
 * gets SHOWN, the same division `lib/approvalLadder.ts`'s doc comment
 * already establishes for its pure helpers.
 */
export function ApprovalLadder({
  required,
  approvals,
  nextStep,
  schedule,
  viewerCanSign,
  viewerIsOwnRequest = false,
  size = 'card',
}: ApprovalLadderProps): JSX.Element {
  const have = approvals.length;
  const accessibleName = ladderAriaLabel(have, required);

  if (size === 'row') {
    // Collapses to the pre-existing MyRequests pill (S-08: a full segmented
    // stepper has no room on a dense list row) — same visual footprint as
    // the `.rq-row__count` span it replaces, now sharing this component's
    // copy/aria logic instead of a locally hand-rolled `{have}/{required}`.
    // The tooltip is where WHO'S-NEXT still surfaces at this size.
    return (
      <span
        className="ladder ladder--row"
        title={ladderRowTooltip(have, required, nextStep)}
        aria-label={accessibleName}
      >
        <span className="ladder__row-num">{have}</span>
        <span className="ladder__row-sep" aria-hidden="true">
          /
        </span>
        <span className="ladder__row-num">{Math.max(0, required)}</span>
      </span>
    );
  }

  const segments = buildLadderSegments({
    required,
    approvals,
    nextStep,
    viewerCanSign,
    viewerIsOwnRequest,
    resolveName,
    formatTime: formatProjectTime,
  });
  const requiredLabel = Math.max(0, required);

  return (
    <div className={`ladder ladder--${size}`}>
      <ol className="ladder__steps" aria-label={accessibleName}>
        {segments.map((s) => (
          <li key={s.key} className={`ladder__seg ladder__seg--${s.state}`}>
            <span className="ladder__dot" aria-hidden="true" />
            <span className="ladder__text">
              <span className="ladder__label">{s.label}</span>
              {s.sub && <span className="ladder__sub">{s.sub}</span>}
            </span>
          </li>
        ))}
      </ol>
      <div className="ladder__meta">
        <span className="ladder__count">
          <span className="ladder__count-num">{have}</span> of{' '}
          <span className="ladder__count-num">{requiredLabel}</span>{' '}
          {requiredLabel === 1 ? 'approval' : 'approvals'}
        </span>
        {schedule?.kind === 'window' && (
          <span className="ladder__sched">applies {formatProjectTime(schedule.at)}</span>
        )}
      </div>
    </div>
  );
}
