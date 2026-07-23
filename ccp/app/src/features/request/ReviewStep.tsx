import { useState } from 'react';
import type { JSX } from 'react';
import type { Inventory, ManifestOperation, Schedule } from '@/types';
import { exposureLabel } from '@/lib/interpreter';
import { verbFor } from '@/lib/catalog';
import { generateDiff, plainSummary } from '@/lib/diff';
import { DiffView } from '@/components/DiffView';
import { FullBlockDiff } from '@/components/FullBlockDiff';
import { useFullBlockDiff } from '@/components/useFullBlockDiff';
import { approvalsRequiredFor } from '@/lib/permissions';
import { quorumWarning } from '@/lib/quorum';
import { isApiMode } from '@/lib/apiSession';
import { getServiceMeta } from '@/lib/serviceMeta';
import { Button } from '@/components/ui/Button';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { resolveRisk } from '@/lib/riskOverrides';
import { AccessBadge } from '@/components/ui/AccessBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { SchedulePicker, scheduleError } from './SchedulePicker';
import { ChangeAnnotations } from './ChangeAnnotations';
import { ReplaceConfirmGate, isReplaceOp, replaceConfirmMet } from './ReplaceConfirmGate';
import './request.css';

/**
 * OP-4: a Delete against a `lifecycle { prevent_destroy = true }`-protected
 * resource used to pass review with no warning — the diff honestly showed the
 * real committed HCL (guard included), but nothing called the guard out, so
 * the operator only learned Terraform would refuse the plan days later, from
 * a failed CI run. Matched loosely (whitespace-tolerant) against the
 * resource's own committed source text — never against user input, so this
 * can only confirm what the estate itself already declares.
 */
const PREVENT_DESTROY_RE = /lifecycle\s*\{[^}]*prevent_destroy\s*=\s*true/s;

/** True when a resource's committed HCL source carries `lifecycle { prevent_destroy = true }`. */
export function hclHasPreventDestroy(source: string): boolean {
  return PREVENT_DESTROY_RE.test(source);
}

export interface ReviewStepProps {
  op: ManifestOperation;
  values: Record<string, unknown>;
  inventory: Inventory;
  justification: string;
  targetAddress: string;
  submitting: boolean;
  /** When set, submission is blocked (e.g. an admin change-freeze) and the reason
   * is shown; the submit button is disabled. */
  blocked?: string;
  /** Controlled schedule (RequestForm owns it so it can set draft.schedule). */
  schedule?: Schedule;
  onScheduleChange?: (schedule: Schedule) => void;
  /** Controlled typed replace-confirmation (RequestForm owns it so it can set
   * draft.replaceConfirmation). Only meaningful for a forces-replace op. */
  replaceConfirmation?: string;
  onReplaceConfirmationChange?: (value: string) => void;
  /** Jump back to Configure. */
  onEdit: () => void;
  /** Persist the request (RequestForm builds the draft + navigates). */
  onSubmit: () => void;
}

/**
 * The review checkpoint. The requester sees, side by side, the plain-English
 * "what changes" and the exact Terraform the portal generated — the same diff
 * the senior will approve. Below it: the op's honest facts, the justification, a
 * schedule choice (apply now vs a maintenance window), and how many senior
 * approvals it needs. Submit opens the reviewed request; nothing auto-applies.
 */
export function ReviewStep({
  op,
  values,
  inventory,
  justification,
  targetAddress,
  submitting,
  blocked,
  schedule: scheduleProp,
  onScheduleChange,
  replaceConfirmation: replaceConfirmationProp,
  onReplaceConfirmationChange,
  onEdit,
  onSubmit,
}: ReviewStepProps): JSX.Element {
  const meta = getServiceMeta(op.service);
  const summary = plainSummary(op, values, inventory);
  const diff = generateDiff(op, values, inventory);
  const approvals = approvalsRequiredFor(op);
  // Feasibility honesty: quorumWarning() estimates from the LOCAL
  // account directory (lib/quorum.ts), which is only trustworthy in
  // mock-mode (where that directory IS the server). Against ccp-api the
  // real eligibility filter (project-binding + activation) can
  // disagree, and there is no pre-submit feasibility endpoint to ask
  // instead — so api-mode shows nothing here rather than a possibly-wrong
  // local guess. The honest, server-computed notice appears once the
  // request exists: on the ReviewStep→submit result and on RequestDetail
  // (lib/requestFeasibility.ts), from the submit-time snapshot and the live
  // GET .../feasibility endpoint.
  const quorumNote = isApiMode ? null : quorumWarning(approvals);

  // The full enclosing block the L1 is changing, before/after — shared with
  // the approver views so both see the same whole block.
  const blockDiff = useFullBlockDiff(op, values, targetAddress);
  const [showFullBlock, setShowFullBlock] = useState(true);

  // OP-4: a whole-resource Delete (blockDiff.kind === 'remove' — the target's
  // FULL current block, e.g. ebs-delete-volume) whose own committed HCL sets
  // prevent_destroy. Scoped to Delete: a plain attribute/entry edit never
  // trips Terraform's prevent_destroy guard, only a destroy (direct or via a
  // forced replace) does. `blockDiff` is null while loading or for op kinds
  // useFullBlockDiff can't express — this callout simply stays silent then,
  // same as the rest of the full-block view.
  const preventDestroyProtected =
    op.macd === 'Delete' && blockDiff?.kind === 'remove' && hclHasPreventDestroy(blockDiff.before);

  const [localSchedule, setLocalSchedule] = useState<Schedule>({ kind: 'now' });
  const schedule = scheduleProp ?? localSchedule;
  const handleSchedule = (next: Schedule): void => {
    setLocalSchedule(next);
    onScheduleChange?.(next);
  };

  // Forces-replace confirmed-override: the requester must type the resource name before
  // this destroy+recreate can be submitted. Controlled by RequestForm (so it can set
  // draft.replaceConfirmation); the local fallback keeps the field usable in isolation.
  const [localConfirm, setLocalConfirm] = useState('');
  const replaceConfirmation = replaceConfirmationProp ?? localConfirm;
  const handleConfirm = (next: string): void => {
    setLocalConfirm(next);
    onReplaceConfirmationChange?.(next);
  };
  const confirmMet = replaceConfirmMet(op, targetAddress, replaceConfirmation);

  // The picker's own V2-V5 mirror (courtesy only — the server is
  // the enforcement) replaces the old `at===''`-only check, so a past/imminent/
  // too-far/too-long window is caught here too, not just an empty field.
  const scheduleErr = scheduleError(schedule);

  const handleSubmit = (): void => {
    if (scheduleErr) return;
    if (!confirmMet) return; // a forces-replace op cannot submit without the typed confirmation
    onSubmit();
  };

  const needsConfirm = isReplaceOp(op) && !confirmMet;
  const submitLabel = submitting
    ? 'Submitting…'
    : needsConfirm
      ? 'Type the resource name to confirm'
      : verbFor(op.macd);

  return (
    <div className="rq-review">
      <div className="rq-review__head">
        <div>
          <p className="rq-review__eyebrow">REVIEW &amp; SUBMIT</p>
          <h1 className="rq-review__title">
            {meta.displayName} · {op.title}
          </h1>
        </div>
        <MacdTag macd={op.macd} />
      </div>

      <p className="rq-summary" aria-label="Plain-English summary">
        {summary}
      </p>

      <section className="rq-review__section">
        <div className="rq-review__section-head">
          <h2 className="rq-review__section-title">
            {blockDiff && showFullBlock ? 'The block you’re changing' : 'Generated Terraform'}
          </h2>
          {blockDiff && (
            <div className="rq-blocktoggle" role="group" aria-label="Diff view">
              <button
                type="button"
                className={showFullBlock ? 'rq-blocktoggle__btn is-on' : 'rq-blocktoggle__btn'}
                aria-pressed={showFullBlock}
                onClick={() => setShowFullBlock(true)}
              >
                Full block
              </button>
              <button
                type="button"
                className={!showFullBlock ? 'rq-blocktoggle__btn is-on' : 'rq-blocktoggle__btn'}
                aria-pressed={!showFullBlock}
                onClick={() => setShowFullBlock(false)}
              >
                Changes only
              </button>
            </div>
          )}
        </div>
        <p className="rq-diff__note">
          {blockDiff && showFullBlock
            ? 'The complete resource block from the Terraform repo, before and after — so you see exactly what you’re changing, in context.'
            : 'The portal wrote this from your inputs — no HCL by hand. A senior approves this exact diff before it applies.'}
        </p>
        {blockDiff && showFullBlock ? (
          <FullBlockDiff diff={blockDiff} />
        ) : (
          <DiffView diff={diff} />
        )}
        <ChangeAnnotations op={op} values={values} diff={diff} />
      </section>

      <section className="rq-review__section">
        <div className="rq-review__section-head">
          <h2 className="rq-review__section-title">Target &amp; change</h2>
          <button type="button" className="rq-review__edit" onClick={onEdit}>
            Edit
          </button>
        </div>
        <p className="rq-review__lede" style={{ margin: 0 }}>
          {targetAddress ? <code>{targetAddress}</code> : 'A new resource'}
        </p>
      </section>

      <section className="rq-review__section">
        <h2 className="rq-review__section-title">Operation facts</h2>
        <dl className="rq-review__dl">
          <div className="rq-review__row">
            <dt>Risk</dt>
            <dd>
              <RiskBadge risk={resolveRisk(op)} />
            </dd>
          </div>
          <div className="rq-review__row">
            <dt>Reversible</dt>
            <dd>{op.reversible ? 'Yes' : 'No — irreversible'}</dd>
          </div>
          <div className="rq-review__row">
            <dt>Downtime</dt>
            <dd>{op.downtime === 'none' ? 'None' : op.downtime}</dd>
          </div>
          <div className="rq-review__row">
            <dt>Exposure</dt>
            <dd>
              <AccessBadge exposure={op.exposure} />{' '}
              <span className="rq-review__exp-label">{exposureLabel(op.exposure)}</span>
            </dd>
          </div>
          <div className="rq-review__row">
            <dt>Terraform</dt>
            <dd className="rq-impact__mono">{op.terraformCapability}</dd>
          </div>
        </dl>
      </section>

      <section className="rq-review__section">
        <div className="rq-review__section-head">
          <h2 className="rq-review__section-title">Justification</h2>
          <button type="button" className="rq-review__edit" onClick={onEdit}>
            Edit
          </button>
        </div>
        <p className="rq-review__just">{justification}</p>
      </section>

      <section className="rq-review__section">
        <h2 className="rq-review__section-title">When to apply</h2>
        <SchedulePicker value={schedule} onChange={handleSchedule} />
      </section>

      <p className="rq-approvals" role="note">
        Needs <strong>{approvals}</strong> approval{approvals > 1 ? 's' : ''} before it applies.
      </p>

      {quorumNote && (
        <p className="rq-quorum-warn" role="alert">
          {quorumNote}
        </p>
      )}

      {preventDestroyProtected && (
        <p className="rq-quorum-warn" role="alert">
          This resource is protected — its Terraform sets{' '}
          <code>lifecycle {'{'} prevent_destroy = true {'}'}</code>. Terraform will refuse to
          destroy it as submitted; an engineer must lift the guard first.
        </p>
      )}

      {blocked && (
        <p className="rq-quorum-warn" role="alert">
          {blocked}
        </p>
      )}

      <ReplaceConfirmGate
        op={op}
        targetAddress={targetAddress}
        value={replaceConfirmation}
        onChange={handleConfirm}
      />

      <div className="rq-review__actions">
        <Button
          variant="primary"
          onClick={handleSubmit}
          disabled={submitting || scheduleErr !== undefined || blocked !== undefined || !confirmMet}
        >
          {submitLabel}
        </Button>
        <button type="button" className="rq-cancel" onClick={onEdit}>
          Back to edit
        </button>
      </div>
    </div>
  );
}
