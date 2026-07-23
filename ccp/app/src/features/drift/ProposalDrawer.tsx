import { Fragment } from 'react';
import type { JSX } from 'react';
import type { Schedule } from '@/types';
import type { DriftProposal, DriftVerdict } from '@/types/drift';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { DiffView } from '@/components/DiffView';
import { SchedulePicker } from '@/features/request/SchedulePicker';
import type { DriftProposalState } from './driftProposalState';
import './drift.css';

/**
 * The per-row proposal affordance + the detail drawer it opens — the
 * pure/prop-driven half (renderToStaticMarkup-testable, no jsdom in this
 * repo); {@link DriftPage} owns the one stateful piece (which digest is
 * open, the justification/schedule form values, the submit call).
 */

export const MIN_JUSTIFICATION = 10;

/**
 * The standing blast-radius honesty note (drift-portal spec, the apply-lane
 * section): this estate applies one root, so an apply is never scoped to
 * only the addresses shown above it. Exported as a constant — rendered
 * verbatim, never paraphrased per-proposal — so a submit flow can never
 * imply a narrower blast radius than the truth.
 */
export const DRIFT_BLAST_RADIUS_NOTE =
  'This estate applies one Terraform root. While any other drift is outstanding, applying this change also reverts every other drifted resource to the code already on main — the blast radius here is never just the resource above. Adopt or revert the remaining drift first if that is not what should happen.';

/**
 * C1's dependency/blast-radius caution (spec addendum A6, the plan's finding
 * C write-up): a
 * revert re-imposes code over a live security-posture change, and that
 * changed rule or permission may already be in use by something else —
 * reverting it can break whatever started relying on it. Rendered on every
 * revert proposal's surface so no approver blind-reverts something
 * load-bearing; distinct from {@link DRIFT_BLAST_RADIUS_NOTE} (which is
 * about the apply's SCOPE, not this) — both render together.
 */
export const DRIFT_REVERT_DEPENDENCY_CAUTION =
  'This rule or permission may already be in use by something that started depending on it after the console change. Confirm nothing relies on the current (live) state before reverting — a revert that breaks a dependency is itself an incident.';

/**
 * C1's CloudTrail-investigation pointer (spec addendum A6): the runbook's
 * evidence duty made concrete on the proposal surface itself, not just
 * implied by the justification field's help text — the approving lead is
 * signing that this happened.
 */
export const DRIFT_CLOUDTRAIL_POINTER =
  'Before reverting, capture who made this change and why: check CloudTrail for the API call that produced it (actor, source, time) and record what you find in the justification below.';

export interface DriftProposalChipProps {
  state: DriftProposalState | null;
  onOpen?: () => void;
}

/**
 * The verdict table's per-row chip — one of the drift surface's five
 * states. Only `adopt`/`revert`/`restore` are clickable (there is a
 * proposal to show detail for); `ungenerable`/`not-armed` are plain,
 * informational text. `state === null` (no proposals data for this tier —
 * Requester) renders nothing: presence follows duty, same as every other
 * approver+ field.
 */
export function DriftProposalChip({ state, onOpen }: DriftProposalChipProps): JSX.Element | null {
  if (state === null) return null;
  if (state.kind === 'adopt') {
    return (
      <button type="button" className="drift-fix-btn" onClick={onOpen}>
        <Badge color="ok">Adopt fix generated</Badge>
      </button>
    );
  }
  if (state.kind === 'revert') {
    return (
      <button type="button" className="drift-fix-btn" onClick={onOpen}>
        <Badge color="crit">Revert only — security posture</Badge>
      </button>
    );
  }
  if (state.kind === 'restore') {
    return (
      <button type="button" className="drift-fix-btn" onClick={onOpen}>
        <Badge color="warn">Restore fix generated</Badge>
      </button>
    );
  }
  if (state.kind === 'ungenerable') {
    return (
      <Badge color="muted" title={state.reason}>
        No mechanical fix — see runbook
      </Badge>
    );
  }
  return (
    <Badge color="muted" title="An eligible fix was not generated for this resource on this deployment.">
      Generation not armed
    </Badge>
  );
}

export interface ProposalDrawerProps {
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
  /** Client-side mirror of the server's role gate (adopt: any bound
   * member; revert: approver/lead only) — UI ergonomics only. The server
   * re-enforces this regardless of what this prop says. */
  canSubmit: boolean;
}

/**
 * The detail drawer: the pinned attribute table (the exact machine values
 * the fix reads/writes), a diff preview for adopt (revert carries no
 * edit), the standing blast-radius note, and the submit sub-form
 * (justification + schedule). Submitting navigates to the created request
 * — see features/drift/proposalFlow.ts for that half, kept out of this
 * component so it stays independently testable without React.
 */
export function ProposalDrawer({
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
}: ProposalDrawerProps): JSX.Element {
  const isAdopt = proposal.flavor === 'adopt';
  const justificationTooShort = justification.trim().length < MIN_JUSTIFICATION;

  return (
    <Fragment>
      <div className="drift-drawer__backdrop" onClick={onClose} />
      <div
        className="drift-drawer"
        role="dialog"
        aria-label={`${isAdopt ? 'Adopt' : 'Revert'} proposal for ${verdict.address}`}
      >
        <header className="drift-drawer__head">
          <div>
            <p className="drift-drawer__eyebrow">{isAdopt ? 'Adopt fix' : 'Revert — security posture'}</p>
            <code className="drift-drawer__addr">{verdict.address}</code>
          </div>
          <button type="button" className="drift-drawer__close" onClick={onClose} aria-label="Close">
            ×
          </button>
        </header>

        <table className="drift-drawer__attrs">
          <thead>
            <tr>
              <th>Path</th>
              <th>Live</th>
              <th>Code</th>
            </tr>
          </thead>
          <tbody>
            {proposal.attrs.map((a) => (
              <tr key={`${a.address}-${a.path}`}>
                <td>
                  <code>{a.path}</code>
                </td>
                <td className="drift-drawer__val">{JSON.stringify(a.liveJson)}</td>
                <td className="drift-drawer__val">{JSON.stringify(a.codeJson)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {isAdopt && proposal.diff && (
          <section className="drift-drawer__diff">
            <h3 className="drift-drawer__heading">Diff preview</h3>
            <DiffView diff={proposal.diff} />
          </section>
        )}
        {!isAdopt && (
          <p className="drift-drawer__noedit" role="note">
            No code edit — the gated apply re-imposes the code already on main over the console change.
          </p>
        )}

        {!isAdopt && (
          <div className="drift-drawer__caution" role="note">
            <p className="drift-drawer__caution-line">{DRIFT_REVERT_DEPENDENCY_CAUTION}</p>
            <p className="drift-drawer__caution-line">{DRIFT_CLOUDTRAIL_POINTER}</p>
          </div>
        )}

        <p className="drift-drawer__blast" role="note">
          {DRIFT_BLAST_RADIUS_NOTE}
        </p>

        {canSubmit ? (
          <div className="drift-drawer__form">
            <label className="drift-drawer__field-label" htmlFor="drift-proposal-justification">
              Why {isAdopt ? 'adopt' : 'revert'} this now? <span className="drift-drawer__req">*</span>
            </label>
            <textarea
              id="drift-proposal-justification"
              className="drift-drawer__textarea"
              rows={3}
              value={justification}
              aria-describedby="drift-proposal-justification-help"
              onChange={(e) => onJustificationChange(e.target.value)}
            />
            <p id="drift-proposal-justification-help" className="drift-drawer__help">
              Recorded on the request — at least {MIN_JUSTIFICATION} characters. For a revert, name
              the evidence you captured (who/what changed, and where it is recorded).
            </p>

            <SchedulePicker value={schedule} onChange={onScheduleChange} name="sched-drift-proposal" />

            {error && (
              <p className="drift-drawer__error" role="alert">
                {error}
              </p>
            )}

            <Button variant="primary" onClick={onSubmit} disabled={submitting || justificationTooShort}>
              {submitting ? 'Submitting…' : isAdopt ? 'Submit adopt request' : 'Submit revert request'}
            </Button>
          </div>
        ) : (
          <p className="drift-drawer__norole" role="note">
            Only an approver or a lead can submit a security-posture revert.
          </p>
        )}
      </div>
    </Fragment>
  );
}
