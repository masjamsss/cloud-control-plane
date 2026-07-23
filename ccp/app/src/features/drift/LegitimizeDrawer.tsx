import { Fragment } from 'react';
import type { JSX } from 'react';
import type { Schedule } from '@/types';
import type { DriftProposal, DriftVerdict } from '@/types/drift';
import { Button } from '@/components/ui/Button';
import { SchedulePicker } from '@/features/request/SchedulePicker';
import './drift.css';

/**
 * C2's own drawer — the "legitimize" resolution for security-posture drift
 * (spec addendum A6): instead of reverting the console change, this starts
 * a full-scrutiny, engineer-authored request that converges CODE to the
 * live (emergency) change. Deliberately a SEPARATE component from
 * {@link ProposalDrawer} (which stays C1/revert-only): the two are
 * different resolutions of the SAME evidence, opened from the same security
 * row, never merged into one form — an operator picks one path at a time,
 * and this drawer's copy must never read as "the same as revert."
 *
 * No diff, no pinned "code" column with a value to write: nothing here
 * edits Terraform. The pinned attrs are shown as the evidence an engineer
 * will read to author the exact change by hand.
 */

export const MIN_LEGITIMIZE_JUSTIFICATION = 40;

/**
 * The starter structure the submit form offers (spec addendum A6:
 * "mandatory emergency-citing justification ... the UI provides the
 * template with the CloudTrail-investigation duty"). Inserted into the
 * textarea on request, never silently pre-filled — the operator writes (or
 * edits) the actual justification; this is a shape to follow, not a
 * pre-approved answer.
 */
export const LEGITIMIZE_JUSTIFICATION_TEMPLATE =
  'Emergency change: describe exactly what was changed and why it could not wait for the normal review lane. ' +
  'Evidence: name the CloudTrail event (actor, source, time) that produced the change, and where it is ' +
  'recorded (incident ticket, chat thread, etc.). Outcome: this request converges code to KEEP the change, ' +
  'instead of reverting it.';

export interface LegitimizeDrawerProps {
  verdict: DriftVerdict;
  /** The row's OPEN REVERT proposal — legitimize is C2's resolution of the
   * SAME generated evidence C1 would revert, never a separate proposal. */
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
   * the same rule as revert submit). The server re-enforces regardless. */
  canSubmit: boolean;
}

export function LegitimizeDrawer({
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
}: LegitimizeDrawerProps): JSX.Element {
  const justificationTooShort = justification.trim().length < MIN_LEGITIMIZE_JUSTIFICATION;

  return (
    <Fragment>
      <div className="drift-drawer__backdrop" onClick={onClose} />
      <div
        className="drift-drawer drift-drawer--legitimize"
        role="dialog"
        aria-label={`Legitimize security-posture drift for ${verdict.address}`}
      >
        <header className="drift-drawer__head">
          <div>
            <p className="drift-drawer__eyebrow">Legitimize — converge code instead of reverting</p>
            <code className="drift-drawer__addr">{verdict.address}</code>
          </div>
          <button type="button" className="drift-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <p className="drift-drawer__legitimize-explain" role="note">
          This does not touch Terraform right now. It starts a full-scrutiny request: an engineer authors the
          exact code change that keeps the live value shown below, a lead records it, and the change rides the
          normal review lane — the same as any other engineer-authored change. The revert choice (C1) stays
          available on this row until the next clean check closes the drift record; starting a legitimize
          request does not remove it.
        </p>

        <table className="drift-drawer__attrs">
          <thead>
            <tr>
              <th>Path</th>
              <th>Live value to keep</th>
            </tr>
          </thead>
          <tbody>
            {proposal.attrs.map((a) => (
              <tr key={`${a.address}-${a.path}`}>
                <td>
                  <code>{a.path}</code>
                </td>
                <td className="drift-drawer__val">{JSON.stringify(a.liveJson)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {canSubmit ? (
          <div className="drift-drawer__form">
            <label className="drift-drawer__field-label" htmlFor="drift-legitimize-justification">
              Emergency justification <span className="drift-drawer__req">*</span>
            </label>
            <div className="drift-drawer__template" id="drift-legitimize-template">
              <p className="drift-drawer__template-heading">Suggested structure</p>
              <p className="drift-drawer__template-text">{LEGITIMIZE_JUSTIFICATION_TEMPLATE}</p>
              <button
                type="button"
                className="drift-drawer__template-use"
                onClick={() => onJustificationChange(LEGITIMIZE_JUSTIFICATION_TEMPLATE)}
              >
                Use this template
              </button>
            </div>
            <textarea
              id="drift-legitimize-justification"
              className="drift-drawer__textarea"
              rows={4}
              value={justification}
              aria-describedby="drift-legitimize-justification-help"
              onChange={(e) => onJustificationChange(e.target.value)}
            />
            <p id="drift-legitimize-justification-help" className="drift-drawer__help">
              Recorded on the request and read by the engineer who authors the change — at least{' '}
              {MIN_LEGITIMIZE_JUSTIFICATION} characters, and it must cite the emergency: what happened, the
              CloudTrail evidence for it, and why it should stand.
            </p>

            <SchedulePicker value={schedule} onChange={onScheduleChange} name="sched-drift-legitimize" />

            {error && (
              <p className="drift-drawer__error" role="alert">
                {error}
              </p>
            )}

            <Button variant="primary" onClick={onSubmit} disabled={submitting || justificationTooShort}>
              {submitting ? 'Starting…' : 'Start legitimize request'}
            </Button>
          </div>
        ) : (
          <p className="drift-drawer__norole" role="note">
            Only an approver or a lead can start a legitimize request for security-posture drift.
          </p>
        )}
      </div>
    </Fragment>
  );
}
