import { Fragment } from 'react';
import type { JSX } from 'react';
import type { Schedule } from '@/types';
import type { DriftFinding, DriftProposal } from '@/types/drift';
import { Button } from '@/components/ui/Button';
import { SchedulePicker } from '@/features/request/SchedulePicker';
import { formatProjectTime } from '@/lib/datetime';
import { DRIFT_BLAST_RADIUS_NOTE, MIN_JUSTIFICATION } from './ProposalDrawer';
import { UnmanagedFooter } from './UnmanagedResources';
import './drift.css';

/**
 * The import proposal's detail/submit drawer (out-of-band provisioning
 * spec — extends ProposalDrawer's shape): the pinned import block +
 * generated HCL skeleton rendered as code (the exact bytes that would land
 * on `main`), the CloudTrail actor evidence, the standing blast-radius
 * note (SHARED verbatim with ProposalDrawer's adopt/revert drawer — one
 * Terraform root, one truth about apply scope), the standing
 * delete-in-AWS footer, and the submit sub-form. A SEPARATE component from
 * ProposalDrawer (not a third branch inside it): an import proposal pins a
 * `finding` + `importPayload`, not `attrs`/a diff, and it opens from a
 * DIFFERENT list (the unmanaged-resources section, not the verdict table)
 * — the same reason LegitimizeDrawer is its own file rather than a third
 * ProposalDrawer branch.
 */

export interface ImportDrawerProps {
  finding: DriftFinding;
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
   * the same rule as revert submit: adopting an unknown actor's resource
   * into legitimacy is a posture judgment, not a self-service one). The
   * server re-enforces this regardless of what this prop says. */
  canSubmit: boolean;
}

/**
 * The import drawer never renders anything an adversarial reader could
 * mistake for a security-family import affordance, because it is only ever
 * reachable from an `{kind: 'import'}` {@link FindingProposalState} — see
 * driftProposalState.ts's findingProposalStateFor, which can structurally
 * never produce that state for a security-family finding.
 */
export function ImportDrawer({
  finding,
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
}: ImportDrawerProps): JSX.Element {
  const payload = proposal.importPayload;
  const justificationTooShort = justification.trim().length < MIN_JUSTIFICATION;

  return (
    <Fragment>
      <div className="drift-drawer__backdrop" onClick={onClose} />
      <div
        className="drift-drawer drift-drawer--import"
        role="dialog"
        aria-label={`Import proposal for ${finding.name}`}
      >
        <header className="drift-drawer__head">
          <div>
            <p className="drift-drawer__eyebrow">Import — unmanaged resource</p>
            <code className="drift-drawer__addr">{payload?.address ?? finding.name}</code>
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
              <td className="drift-drawer__val">{finding.tfType}</td>
            </tr>
            {finding.liveId && (
              <tr>
                <td>Live id</td>
                <td className="drift-drawer__val">{finding.liveId}</td>
              </tr>
            )}
            {finding.arn && (
              <tr>
                <td>ARN</td>
                <td className="drift-drawer__val">{finding.arn}</td>
              </tr>
            )}
          </tbody>
        </table>

        <section className="drift-drawer__evidence" aria-label="CloudTrail evidence">
          <h3 className="drift-drawer__heading">Evidence</h3>
          {finding.actor === null && (
            <p className="unmanaged-row__actor">
              No CloudTrail match found yet — the evidence lookup duty is still open; capture what you can by
              hand before submitting.
            </p>
          )}
          {finding.actor && (
            <p className="unmanaged-row__actor">
              {finding.actor.eventName} by {finding.actor.who}
              {finding.actor.sourceIp ? ` from ${finding.actor.sourceIp}` : ''} at{' '}
              {formatProjectTime(finding.actor.eventTime)}
            </p>
          )}
        </section>

        {payload && (
          <section className="drift-drawer__diff">
            <h3 className="drift-drawer__heading">Generated Terraform — exact bytes</h3>
            <pre className="import-code">
              <code>{payload.importBlock}</code>
            </pre>
            <pre className="import-code">
              <code>{payload.skeletonHcl}</code>
            </pre>
            <p className="drift-drawer__help">
              Writes to {payload.targetFile} unchanged from what is shown above — the gate requires the resulting
              plan show only this import at a no-op, nothing else.
            </p>
          </section>
        )}

        <p className="drift-drawer__blast" role="note">
          {DRIFT_BLAST_RADIUS_NOTE}
        </p>

        <UnmanagedFooter />

        {canSubmit ? (
          <div className="drift-drawer__form">
            <label className="drift-drawer__field-label" htmlFor="drift-import-justification">
              Why import this now? <span className="drift-drawer__req">*</span>
            </label>
            <textarea
              id="drift-import-justification"
              className="drift-drawer__textarea"
              rows={3}
              value={justification}
              aria-describedby="drift-import-justification-help"
              onChange={(e) => onJustificationChange(e.target.value)}
            />
            <p id="drift-import-justification-help" className="drift-drawer__help">
              Recorded on the request — at least {MIN_JUSTIFICATION} characters. Name why this resource belongs in
              Terraform rather than being deleted in AWS.
            </p>

            <SchedulePicker value={schedule} onChange={onScheduleChange} name="sched-drift-import" />

            {error && (
              <p className="drift-drawer__error" role="alert">
                {error}
              </p>
            )}

            <Button variant="primary" onClick={onSubmit} disabled={submitting || justificationTooShort}>
              {submitting ? 'Submitting…' : 'Submit import request'}
            </Button>
          </div>
        ) : (
          <p className="drift-drawer__norole" role="note">
            Only an approver or a lead can submit an unmanaged-resource import.
          </p>
        )}
      </div>
    </Fragment>
  );
}
