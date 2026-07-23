import { Fragment } from 'react';
import type { JSX } from 'react';
import type { Schedule } from '@/types';
import type { DriftProposal, DriftVerdict } from '@/types/drift';
import { Button } from '@/components/ui/Button';
import { SchedulePicker } from '@/features/request/SchedulePicker';
import { formatProjectTime } from '@/lib/datetime';
import { DRIFT_BLAST_RADIUS_NOTE, MIN_JUSTIFICATION } from './ProposalDrawer';
import './drift.css';

/**
 * The restore proposal's detail/submit drawer (drift restore tranche, L29
 * — a portal flavor for `oob_deletion`/D4: a resource present in code+state
 * that a console deletion removed). A SEPARATE component from
 * {@link ProposalDrawer} (not a third branch inside it), the same reason
 * {@link LegitimizeDrawer}/`ImportDrawer` are their own files: restore's
 * copy must never read as "the same as adopt/revert," and its two honesty
 * blocks below are MANDATORY, never optional prose. Sibling of
 * `ImportDrawer` in shape (a verdict-identity table, not a live/code diff
 * — a restore proposal's `attrs` is always empty; there is nothing to
 * diff, only a whole resource to re-create).
 *
 * Reachable only from a `{kind: 'restore'}` {@link DriftProposalState} —
 * see driftProposalState.ts's `driftProposalStateFor`, which can
 * structurally never produce that state for a security-posture verdict
 * (isSecurityPosture is checked first, unconditionally, in
 * lib/driftEligibility.ts's classifyDrift) — so this drawer never renders
 * for a forged/mislabeled security row.
 */

/**
 * The MANDATORY data-loss honesty block (the drift restore tranche plan's
 * SPA-surface section, byte-pinned by a render test) — restore re-creates
 * the Terraform SHAPE, never the data that lived inside the deleted
 * resource. Exported as a constant, rendered verbatim, never paraphrased,
 * so no future edit can soften or drop it.
 */
export const DRIFT_RESTORE_DATA_LOSS_NOTE =
  'Restore re-creates this resource from the code on main. Any data that lived in the deleted resource — ' +
  'object contents, database rows, logs, attached state — is not recovered by this action. If the resource ' +
  'held data, recovery is a separate human runbook path (see the state-recovery runbook) that must happen ' +
  'before or instead of this.';

/**
 * The D4 evidence duty (runbook D4 / the drift restore tranche plan's
 * SPA-surface section), the second MANDATORY honesty block: an
 * out-of-band deletion is not automatically benign — a deleted
 * logging/audit resource is also a security event — so the
 * approving lead is signing that the CloudTrail evidence step happened,
 * not merely that the plan looks clean.
 */
export const DRIFT_RESTORE_EVIDENCE_DUTY =
  'Before approving: capture the CloudTrail Delete* event — who, when, from where — and record it on the ' +
  'drift record. A deleted logging/audit resource is also a security event. The approving lead signs that ' +
  'this evidence step happened.';

export interface RestoreDrawerProps {
  verdict: DriftVerdict;
  proposal: DriftProposal;
  justification: string;
  onJustificationChange: (value: string) => void;
  schedule: Schedule;
  onScheduleChange: (schedule: Schedule) => void;
  onSubmit: () => void;
  onClose: () => void;
  submitting: boolean;
  error?: string | null;
  /** Client-side mirror of the server's role gate (approver/lead only —
   * the same rule as revert/import submit: re-creating infrastructure is a
   * posture judgment, not a self-service one). The server re-enforces this
   * regardless of what this prop says. */
  canSubmit: boolean;
}

export function RestoreDrawer({
  verdict,
  proposal,
  justification,
  onJustificationChange,
  schedule,
  onScheduleChange,
  onSubmit,
  onClose,
  submitting,
  error,
  canSubmit,
}: RestoreDrawerProps): JSX.Element {
  const justificationTooShort = justification.trim().length < MIN_JUSTIFICATION;

  return (
    <Fragment>
      <div className="drift-drawer__backdrop" onClick={onClose} />
      <div
        className="drift-drawer drift-drawer--restore"
        role="dialog"
        aria-label={`Restore proposal for ${verdict.address}`}
      >
        <header className="drift-drawer__head">
          <div>
            <p className="drift-drawer__eyebrow">Restore — out-of-band deletion</p>
            <code className="drift-drawer__addr">{verdict.address}</code>
          </div>
          <button type="button" className="drift-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <table className="drift-drawer__attrs">
          <thead>
            <tr>
              <th>Field</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Type</td>
              <td className="drift-drawer__val">{verdict.type}</td>
            </tr>
            <tr>
              <td>Risk tier</td>
              <td className="drift-drawer__val">{verdict.riskTier}</td>
            </tr>
            <tr>
              <td>Proposal generated</td>
              <td className="drift-drawer__val">{formatProjectTime(proposal.generatedAt)}</td>
            </tr>
          </tbody>
        </table>

        <p className="drift-drawer__noedit" role="note">
          No code edit — the gated apply re-asserts the code already on main, scoped to this address. The
          resulting plan must show a pure create (or an already-converged no-op) here, nothing else.
        </p>

        <div className="drift-drawer__caution" role="note">
          <p className="drift-drawer__caution-line">{DRIFT_RESTORE_DATA_LOSS_NOTE}</p>
          <p className="drift-drawer__caution-line">{DRIFT_RESTORE_EVIDENCE_DUTY}</p>
        </div>

        <p className="drift-drawer__blast" role="note">
          {DRIFT_BLAST_RADIUS_NOTE}
        </p>

        {canSubmit ? (
          <div className="drift-drawer__form">
            <label className="drift-drawer__field-label" htmlFor="drift-restore-justification">
              Why restore this now? <span className="drift-drawer__req">*</span>
            </label>
            <textarea
              id="drift-restore-justification"
              className="drift-drawer__textarea"
              rows={3}
              value={justification}
              aria-describedby="drift-restore-justification-help"
              onChange={(e) => onJustificationChange(e.target.value)}
            />
            <p id="drift-restore-justification-help" className="drift-drawer__help">
              Recorded on the request — at least {MIN_JUSTIFICATION} characters. Name the CloudTrail deletion
              evidence you captured (who/what/when) and why this deletion should be reversed rather than
              accepted (removing the resource from code instead).
            </p>

            <SchedulePicker value={schedule} onChange={onScheduleChange} name="sched-drift-restore" />

            {error && (
              <p className="drift-drawer__error" role="alert">
                {error}
              </p>
            )}

            <Button variant="primary" onClick={onSubmit} disabled={submitting || justificationTooShort}>
              {submitting ? 'Submitting…' : 'Submit restore request'}
            </Button>
          </div>
        ) : (
          <p className="drift-drawer__norole" role="note">
            Only an approver or a lead can submit a drift restore.
          </p>
        )}
      </div>
    </Fragment>
  );
}
