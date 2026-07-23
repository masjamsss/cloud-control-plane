import type { JSX } from 'react';
import type { Schedule } from '@/types';
import type { DriftFinding, DriftProposal, DriftVerdict } from '@/types/drift';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { SchedulePicker } from '@/features/request/SchedulePicker';
import { MIN_JUSTIFICATION } from './ProposalDrawer';
import { driftProposalStateFor, findingProposalStateFor } from './driftProposalState';
import './drift.css';

/**
 * "Fix the drift"'s batch resolution flow (spec addendum A7 / plan B2): one
 * view over the CURRENT report's every row, grouped by what can be done —
 * ADOPT rows batch-select into one change-set submit; SECURITY rows offer
 * the C1 revert / C2 legitimize choice (never an adopt affordance —
 * structurally impossible here, see {@link partitionForResolution}); rows
 * the partition itself refuses render their (enriched) reason plus the
 * manual path it names. Pure/prop-driven (renderToStaticMarkup-testable, no
 * jsdom in this repo) — DriftPage owns every piece of state this needs
 * (selection, the shared batch form, which drawer is open) and the actual
 * C1/C2 forms live in ProposalDrawer/LegitimizeDrawer, opened as overlays
 * exactly like the per-row table chip already does; this component only
 * renders the CHOICE.
 */

export interface AdoptCandidate {
  verdict: DriftVerdict;
  proposal: DriftProposal;
}
export interface SecurityCandidate {
  verdict: DriftVerdict;
  proposal: DriftProposal;
}
export interface UngenerableCandidate {
  verdict: DriftVerdict;
  reason: string;
}
/** One restore-eligible out-of-band-deletion verdict paired with its
 * generated restore proposal — drift restore tranche (L29), mirroring
 * {@link AdoptCandidate} exactly (a verdict-sourced bucket, the same as
 * adopt/security — restore needs no extra `findings`-style argument, since
 * it comes from the SAME `verdicts` this function already walks). */
export interface RestoreCandidate {
  verdict: DriftVerdict;
  proposal: DriftProposal;
}
/** One import-eligible unmanaged-resource finding paired with its
 * generated import proposal — out-of-band provisioning spec, mirroring
 * {@link AdoptCandidate} one level down (a finding instead of a verdict). */
export interface ImportCandidate {
  finding: DriftFinding;
  proposal: DriftProposal;
}

export interface ResolutionPartition {
  adopt: AdoptCandidate[];
  security: SecurityCandidate[];
  /** Restore-eligible out-of-band-deletion verdicts with a live matching
   * restore proposal (drift restore tranche, L29) — a CORE bucket, always
   * computed (unlike `importEligible` below): it is sourced from the same
   * `verdicts` array adopt/security/ungenerable/notArmed already walk, so
   * it needs no additional argument to populate. */
  restore: RestoreCandidate[];
  ungenerable: UngenerableCandidate[];
  /** Eligible-looking (adopt, revert, or restore-shaped) verdicts with no
   * matching generated proposal — most plausibly because generation isn't
   * armed on this deployment (see driftProposalState.ts's 'not-armed'
   * doc). */
  notArmed: DriftVerdict[];
  /** Import-eligible unmanaged-resource findings with a live matching
   * import proposal — additive (out-of-band provisioning spec). OPTIONAL,
   * and never set at all when {@link partitionForResolution} is called
   * without a `findings` argument, so every existing 2-argument call site
   * (verdict-only resolution) keeps returning the EXACT pre-existing
   * shape, byte for byte — the same additive-absent-means-unchanged
   * doctrine the rest of this spec follows throughout. The three OTHER
   * finding buckets (creation_security / type_unmapped / payload_withheld)
   * are deliberately NOT mirrored here: the always-visible
   * unmanaged-resources section already renders every finding with its own
   * chip + reason: this batch view exists only for the MULTI-SELECT
   * action, exactly like the adopt section above lists only adopt-eligible
   * verdicts, never the ungenerable/not-armed ones as a "choice."
   */
  importEligible?: ImportCandidate[];
}

/**
 * Groups every verdict in the current report by its resolution path, reusing
 * {@link driftProposalStateFor} row for row — the SAME re-derivation THE
 * BINDING INVARIANT rests on (a security verdict can structurally never
 * land in `adopt`, no matter what any proposal's own `flavor` label claims).
 * `proposals` undefined (Requester tier) yields every list empty — this
 * flow is never rendered for a Requester regardless (DriftPage gates it),
 * but the function itself stays honest rather than assuming a caller.
 *
 * `findings`, when passed, is grouped THE SAME WAY one level down, via
 * {@link findingProposalStateFor} — the identical defense-in-depth
 * doctrine: a security-family finding can structurally never land in
 * `importEligible`, no matter what any proposal's own `flavor` label
 * claims (see driftProposalState.ts for why).
 */
export function partitionForResolution(
  verdicts: DriftVerdict[],
  proposals: DriftProposal[] | undefined,
  findings?: DriftFinding[],
): ResolutionPartition {
  const out: ResolutionPartition = { adopt: [], security: [], restore: [], ungenerable: [], notArmed: [] };
  if (proposals === undefined) return out;
  for (const verdict of verdicts) {
    const state = driftProposalStateFor(verdict, proposals);
    if (state === null) continue;
    if (state.kind === 'adopt') out.adopt.push({ verdict, proposal: state.proposal });
    else if (state.kind === 'revert') out.security.push({ verdict, proposal: state.proposal });
    else if (state.kind === 'restore') out.restore.push({ verdict, proposal: state.proposal });
    else if (state.kind === 'ungenerable') out.ungenerable.push({ verdict, reason: state.reason });
    else out.notArmed.push(verdict);
  }
  if (findings !== undefined) {
    out.importEligible = [];
    for (const finding of findings) {
      const state = findingProposalStateFor(finding, proposals);
      if (state && state.kind === 'import') out.importEligible.push({ finding, proposal: state.proposal });
    }
  }
  return out;
}

export interface ResolutionFlowProps {
  partition: ResolutionPartition;
  selectedAdopt: ReadonlySet<string>;
  allAdoptSelected: boolean;
  onToggleAdopt: (digest: string) => void;
  onToggleSelectAllAdopt: () => void;
  batchJustification: string;
  onBatchJustificationChange: (value: string) => void;
  batchSchedule: Schedule;
  onBatchScheduleChange: (schedule: Schedule) => void;
  onSubmitBatch: () => void;
  batchSubmitting: boolean;
  batchError?: string | null;
  onChooseRevert: (digest: string) => void;
  onChooseLegitimize: (digest: string) => void;
  /** Client-side mirror of the server's role gate for revert/legitimize
   * (approver/lead only) — the same doctrine as ProposalDrawer's canSubmit;
   * the server re-enforces regardless of what this renders. */
  canRevertOrLegitimize: boolean;

  /**
   * Restore batch selection state (drift restore tranche, L29) — the SAME
   * shape as the adopt batch above (restore is a core, always-present
   * bucket, not gated behind an extra argument the way import is): a
   * restore-only multi-select into ONE `alsoDigests` submit, mirroring the
   * Import section below; never mixable with the adopt batch (the api
   * refuses a mixed-flavor batch regardless — this is client ergonomics,
   * not the enforcement).
   */
  selectedRestore: ReadonlySet<string>;
  allRestoreSelected: boolean;
  onToggleRestore: (digest: string) => void;
  onToggleSelectAllRestore: () => void;
  restoreBatchJustification: string;
  onRestoreBatchJustificationChange: (value: string) => void;
  restoreBatchSchedule: Schedule;
  onRestoreBatchScheduleChange: (schedule: Schedule) => void;
  onSubmitRestoreBatch: () => void;
  restoreBatchSubmitting: boolean;
  restoreBatchError?: string | null;
  /** Client-side mirror of the server's role gate for restore (approver/
   * lead only — the SAME rule revert/import use: re-creating infrastructure
   * is a posture judgment, not a self-service one). */
  canRestore: boolean;

  /**
   * Import batch selection state (out-of-band provisioning spec) — ALL
   * optional, mirroring `partition.importEligible`'s own optionality:
   * omitted together (as every pre-existing call site in this repo does),
   * this component renders IDENTICALLY to the verdict-only ResolutionFlow,
   * byte for byte — the section below is gated on
   * `partition.importEligible` being present, never on these alone.
   */
  selectedImport?: ReadonlySet<string>;
  allImportSelected?: boolean;
  onToggleImport?: (digest: string) => void;
  onToggleSelectAllImport?: () => void;
  importBatchJustification?: string;
  onImportBatchJustificationChange?: (value: string) => void;
  importBatchSchedule?: Schedule;
  onImportBatchScheduleChange?: (schedule: Schedule) => void;
  onSubmitImportBatch?: () => void;
  importBatchSubmitting?: boolean;
  importBatchError?: string | null;
  /** Client-side mirror of the server's role gate for import (approver/lead
   * only — the SAME rule revert uses: adopting an unknown actor's resource
   * into legitimacy is a posture judgment, not a self-service one). */
  canImport?: boolean;
}

function ImportAttrSummary({ finding }: { finding: DriftFinding }): JSX.Element {
  return (
    <span className="resolution__attrs">
      {finding.tfType || 'unmapped type'} · {finding.name}
    </span>
  );
}

function AttrSummary({ proposal }: { proposal: DriftProposal }): JSX.Element {
  return (
    <span className="resolution__attrs">
      {proposal.attrs.map((a) => a.path).join(', ')}
    </span>
  );
}

/** A restore proposal's `attrs` is always empty (there is nothing to diff —
 * restore re-creates the whole resource, never edits an attribute), so its
 * row summary names the resource TYPE instead, mirroring
 * {@link ImportAttrSummary}'s own reason for existing one level down. */
function RestoreAttrSummary({ verdict }: { verdict: DriftVerdict }): JSX.Element {
  return <span className="resolution__attrs">{verdict.type}</span>;
}

export function ResolutionFlow({
  partition,
  selectedAdopt,
  allAdoptSelected,
  onToggleAdopt,
  onToggleSelectAllAdopt,
  batchJustification,
  onBatchJustificationChange,
  batchSchedule,
  onBatchScheduleChange,
  onSubmitBatch,
  batchSubmitting,
  batchError,
  onChooseRevert,
  onChooseLegitimize,
  canRevertOrLegitimize,
  selectedRestore,
  allRestoreSelected,
  onToggleRestore,
  onToggleSelectAllRestore,
  restoreBatchJustification,
  onRestoreBatchJustificationChange,
  restoreBatchSchedule,
  onRestoreBatchScheduleChange,
  onSubmitRestoreBatch,
  restoreBatchSubmitting,
  restoreBatchError,
  canRestore,
  selectedImport,
  allImportSelected,
  onToggleImport,
  onToggleSelectAllImport,
  importBatchJustification,
  onImportBatchJustificationChange,
  importBatchSchedule,
  onImportBatchScheduleChange,
  onSubmitImportBatch,
  importBatchSubmitting,
  importBatchError,
  canImport,
}: ResolutionFlowProps): JSX.Element {
  // `importEligible` stays undefined unless a caller passes findings into
  // partitionForResolution — the section below never renders in that case,
  // so every pre-existing (verdict-only) call site is unaffected.
  const importEligible = partition.importEligible ?? [];
  const nothingToShow =
    partition.adopt.length === 0 &&
    partition.security.length === 0 &&
    partition.restore.length === 0 &&
    partition.ungenerable.length === 0 &&
    partition.notArmed.length === 0 &&
    importEligible.length === 0;
  const batchJustificationTooShort = batchJustification.trim().length < MIN_JUSTIFICATION;
  const restoreBatchJustificationTooShort = restoreBatchJustification.trim().length < MIN_JUSTIFICATION;
  const importBatchJustificationTooShort = (importBatchJustification ?? '').trim().length < MIN_JUSTIFICATION;

  return (
    <section className="resolution" aria-label="Fix the drift">
      <header className="resolution__head">
        <h2 className="resolution__title">Fix the drift</h2>
        <p className="resolution__subtitle" id="resolution-subtitle">
          Every drifted resource in the current report, grouped by what can be done about it. Every fix below
          still goes through the normal request ladder — nothing here submits or applies on its own.
        </p>
      </header>

      {nothingToShow && (
        <p className="resolution__empty">Nothing to resolve — the current report has no drifted resources.</p>
      )}

      {partition.adopt.length > 0 && (
        <div className="resolution__section" aria-labelledby="resolution-adopt-heading">
          <h3 id="resolution-adopt-heading" className="resolution__section-title">
            Adopt — benign in-place drift ({partition.adopt.length})
          </h3>
          <p className="resolution__section-help" id="resolution-adopt-help">
            Select the resources whose live value should become the new code. Every selection ships as ONE
            reviewed change — one apply, less left over to revert.
          </p>
          <label className="resolution__select-all">
            <input type="checkbox" checked={allAdoptSelected} onChange={onToggleSelectAllAdopt} />
            Select all {partition.adopt.length}
          </label>
          <ul className="resolution__list">
            {partition.adopt.map(({ verdict, proposal }) => (
              <li key={proposal.digest} className="resolution__row">
                <label className="resolution__row-label">
                  <input
                    type="checkbox"
                    checked={selectedAdopt.has(proposal.digest)}
                    onChange={() => onToggleAdopt(proposal.digest)}
                    aria-describedby="resolution-adopt-help"
                  />
                  <span>
                    <code className="resolution__addr">{verdict.address}</code>
                    <AttrSummary proposal={proposal} />
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {selectedAdopt.size > 0 && (
            <div className="resolution__batch-form">
              <label className="drift-drawer__field-label" htmlFor="resolution-batch-justification">
                Why adopt {selectedAdopt.size === 1 ? 'this now' : `these ${selectedAdopt.size} now`}?{' '}
                <span className="drift-drawer__req">*</span>
              </label>
              <textarea
                id="resolution-batch-justification"
                className="drift-drawer__textarea"
                rows={3}
                value={batchJustification}
                aria-describedby="resolution-batch-justification-help"
                onChange={(e) => onBatchJustificationChange(e.target.value)}
              />
              <p id="resolution-batch-justification-help" className="drift-drawer__help">
                Recorded on the one combined request — at least {MIN_JUSTIFICATION} characters.
              </p>
              <SchedulePicker value={batchSchedule} onChange={onBatchScheduleChange} name="sched-drift-batch" />
              {batchError && (
                <p className="drift-drawer__error" role="alert">
                  {batchError}
                </p>
              )}
              <Button
                variant="primary"
                onClick={onSubmitBatch}
                disabled={batchSubmitting || batchJustificationTooShort}
              >
                {batchSubmitting
                  ? 'Submitting…'
                  : `Submit ${selectedAdopt.size} adopt fix${selectedAdopt.size === 1 ? '' : 'es'}`}
              </Button>
            </div>
          )}
        </div>
      )}

      {importEligible.length > 0 && (
        <div className="resolution__section" aria-labelledby="resolution-import-heading">
          <h3 id="resolution-import-heading" className="resolution__section-title">
            Import — unmanaged resources ready to import ({importEligible.length})
          </h3>
          <p className="resolution__section-help" id="resolution-import-help">
            Select the unmanaged resources to bring into Terraform. Each selection writes a declarative import
            block plus its generated resource skeleton, exactly as shown in its drawer — never a create, update,
            or destroy anywhere else in the resulting plan.
          </p>
          {!canImport && (
            <p className="resolution__row-norole" role="note">
              Only an approver or a lead can import an unmanaged resource.
            </p>
          )}
          <label className="resolution__select-all">
            <input
              type="checkbox"
              checked={allImportSelected ?? false}
              onChange={onToggleSelectAllImport}
              disabled={!canImport}
            />
            Select all {importEligible.length}
          </label>
          <ul className="resolution__list">
            {importEligible.map(({ finding, proposal }) => (
              <li key={proposal.digest} className="resolution__row">
                <label className="resolution__row-label">
                  <input
                    type="checkbox"
                    checked={selectedImport?.has(proposal.digest) ?? false}
                    onChange={() => onToggleImport?.(proposal.digest)}
                    aria-describedby="resolution-import-help"
                    disabled={!canImport}
                  />
                  <span>
                    <code className="resolution__addr">{proposal.addresses[0]}</code>
                    <ImportAttrSummary finding={finding} />
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {(selectedImport?.size ?? 0) > 0 && canImport && (
            <div className="resolution__batch-form">
              <label className="drift-drawer__field-label" htmlFor="resolution-import-justification">
                Why import {selectedImport?.size === 1 ? 'this now' : `these ${selectedImport?.size ?? 0} now`}?{' '}
                <span className="drift-drawer__req">*</span>
              </label>
              <textarea
                id="resolution-import-justification"
                className="drift-drawer__textarea"
                rows={3}
                value={importBatchJustification ?? ''}
                aria-describedby="resolution-import-justification-help"
                onChange={(e) => onImportBatchJustificationChange?.(e.target.value)}
              />
              <p id="resolution-import-justification-help" className="drift-drawer__help">
                Recorded on the one combined request — at least {MIN_JUSTIFICATION} characters.
              </p>
              <SchedulePicker
                value={importBatchSchedule ?? { kind: 'now' }}
                onChange={(s) => onImportBatchScheduleChange?.(s)}
                name="sched-drift-import-batch"
              />
              {importBatchError && (
                <p className="drift-drawer__error" role="alert">
                  {importBatchError}
                </p>
              )}
              <Button
                variant="primary"
                onClick={onSubmitImportBatch}
                disabled={importBatchSubmitting || importBatchJustificationTooShort}
              >
                {importBatchSubmitting
                  ? 'Submitting…'
                  : `Submit ${selectedImport?.size ?? 0} import${(selectedImport?.size ?? 0) === 1 ? '' : 's'}`}
              </Button>
            </div>
          )}
        </div>
      )}

      {partition.restore.length > 0 && (
        <div className="resolution__section" aria-labelledby="resolution-restore-heading">
          <h3 id="resolution-restore-heading" className="resolution__section-title">
            Restore — out-of-band deletions ({partition.restore.length})
          </h3>
          <p className="resolution__section-help" id="resolution-restore-help">
            Select the deleted resources to restore. Each selection re-asserts the code already on main at that
            address — no code edit, no live values. Restore never recovers data that lived in the deleted
            resource; see each row&apos;s drawer before submitting.
          </p>
          {!canRestore && (
            <p className="resolution__row-norole" role="note">
              Only an approver or a lead can restore an out-of-band deletion.
            </p>
          )}
          <label className="resolution__select-all">
            <input
              type="checkbox"
              checked={allRestoreSelected}
              onChange={onToggleSelectAllRestore}
              disabled={!canRestore}
            />
            Select all {partition.restore.length}
          </label>
          <ul className="resolution__list">
            {partition.restore.map(({ verdict, proposal }) => (
              <li key={proposal.digest} className="resolution__row">
                <label className="resolution__row-label">
                  <input
                    type="checkbox"
                    checked={selectedRestore.has(proposal.digest)}
                    onChange={() => onToggleRestore(proposal.digest)}
                    aria-describedby="resolution-restore-help"
                    disabled={!canRestore}
                  />
                  <span>
                    <code className="resolution__addr">{verdict.address}</code>
                    <RestoreAttrSummary verdict={verdict} />
                  </span>
                </label>
              </li>
            ))}
          </ul>

          {selectedRestore.size > 0 && canRestore && (
            <div className="resolution__batch-form">
              <label className="drift-drawer__field-label" htmlFor="resolution-restore-justification">
                Why restore {selectedRestore.size === 1 ? 'this now' : `these ${selectedRestore.size} now`}?{' '}
                <span className="drift-drawer__req">*</span>
              </label>
              <textarea
                id="resolution-restore-justification"
                className="drift-drawer__textarea"
                rows={3}
                value={restoreBatchJustification}
                aria-describedby="resolution-restore-justification-help"
                onChange={(e) => onRestoreBatchJustificationChange(e.target.value)}
              />
              <p id="resolution-restore-justification-help" className="drift-drawer__help">
                Recorded on the one combined request — at least {MIN_JUSTIFICATION} characters. Name the
                CloudTrail deletion evidence you captured for each address.
              </p>
              <SchedulePicker
                value={restoreBatchSchedule}
                onChange={onRestoreBatchScheduleChange}
                name="sched-drift-restore-batch"
              />
              {restoreBatchError && (
                <p className="drift-drawer__error" role="alert">
                  {restoreBatchError}
                </p>
              )}
              <Button
                variant="primary"
                onClick={onSubmitRestoreBatch}
                disabled={restoreBatchSubmitting || restoreBatchJustificationTooShort}
              >
                {restoreBatchSubmitting
                  ? 'Submitting…'
                  : `Submit ${selectedRestore.size} restore${selectedRestore.size === 1 ? '' : 's'}`}
              </Button>
            </div>
          )}
        </div>
      )}

      {partition.security.length > 0 && (
        <div className="resolution__section" aria-labelledby="resolution-security-heading">
          <h3 id="resolution-security-heading" className="resolution__section-title">
            Security-posture drift — choose a resolution ({partition.security.length})
          </h3>
          <p className="resolution__section-help">
            Every row here changed a watchlisted security surface out-of-band. Choose ONE path per resource:
            revert it (undo the console change) or legitimize it (start a full-scrutiny request that keeps the
            change instead). There is no adopt option on these rows — security-posture drift is never adopted.
          </p>
          <ul className="resolution__list">
            {partition.security.map(({ verdict, proposal }) => (
              <li key={proposal.digest} className="resolution__row resolution__row--security">
                <div>
                  <code className="resolution__addr">{verdict.address}</code>
                  <Badge color="crit">security posture</Badge>
                </div>
                <div className="resolution__security-choice">
                  <Button
                    variant="danger"
                    disabled={!canRevertOrLegitimize}
                    onClick={() => onChooseRevert(proposal.digest)}
                  >
                    Revert (C1)
                  </Button>
                  <p className="resolution__choice-help">Undo the console change — code already on main wins.</p>
                  <Button
                    variant="ghost"
                    disabled={!canRevertOrLegitimize}
                    onClick={() => onChooseLegitimize(proposal.digest)}
                  >
                    Legitimize (C2)
                  </Button>
                  <p className="resolution__choice-help">
                    Keep the change — an engineer authors the code that converges to it, under full review.
                  </p>
                </div>
                {!canRevertOrLegitimize && (
                  <p className="resolution__row-norole" role="note">
                    Only an approver or a lead can revert or legitimize security-posture drift.
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {partition.ungenerable.length > 0 && (
        <div className="resolution__section" aria-labelledby="resolution-ungenerable-heading">
          <h3 id="resolution-ungenerable-heading" className="resolution__section-title">
            No mechanical fix ({partition.ungenerable.length})
          </h3>
          <p className="resolution__section-help">
            These need a human either way — the reason below names the manual path.
          </p>
          <ul className="resolution__list">
            {partition.ungenerable.map(({ verdict, reason }) => (
              <li key={verdict.address} className="resolution__row">
                <code className="resolution__addr">{verdict.address}</code>
                <p className="resolution__reason">{reason}</p>
              </li>
            ))}
          </ul>
        </div>
      )}

      {partition.notArmed.length > 0 && (
        <div className="resolution__section" aria-labelledby="resolution-notarmed-heading">
          <h3 id="resolution-notarmed-heading" className="resolution__section-title">
            Not generated yet ({partition.notArmed.length})
          </h3>
          <p className="resolution__section-help">
            These resources look fixable, but no proposal has been generated for them on this deployment yet —
            an eligible-looking row with no matching proposal most likely means fix generation is not armed
            here.
          </p>
        </div>
      )}
    </section>
  );
}
