import type { JSX } from 'react';
import type { ManifestOperation } from '@/types';
import { consequencesFor, nounForType } from '@/lib/replaceConsequences';
import './request.css';

/**
 * The destroy-and-recreate danger gate on the review page. A forces-replace op does not
 * edit the resource in place — Terraform tears it down and builds a new one — so before it
 * can be submitted the requester must SEE exactly what is destroyed and recreated and TYPE
 * the resource name to confirm. The panel reuses the shared replace-consequence table (the
 * same curated "what a replace costs" copy the plan summary shows later) and states the
 * two-approval requirement. Submit stays disabled until the typed name matches
 * (ReviewStep wires {@link replaceConfirmMet} into the button), so the warning and the
 * confirm cannot be missed or bypassed.
 *
 * Prop-driven and exported for renderToStaticMarkup testing (the PlanSummaryPanel
 * precedent).
 */

/** True when this op is a destroy+recreate that needs the typed confirmation. */
export function isReplaceOp(op: ManifestOperation): boolean {
  return op.forcesReplace === true;
}

/**
 * Whether the review page's submit gate is satisfied. A normal op is always fine; a
 * forces-replace op requires the typed value to exactly match the resource address being
 * replaced — the same binding the server and the executor enforce, so the UI can never let
 * through a request the server would reject.
 */
export function replaceConfirmMet(
  op: ManifestOperation,
  targetAddress: string,
  typed: string,
): boolean {
  if (!isReplaceOp(op)) return true;
  return targetAddress.length > 0 && typed.trim() === targetAddress;
}

export interface ReplaceConfirmGateProps {
  op: ManifestOperation;
  targetAddress: string;
  value: string;
  onChange: (value: string) => void;
}

export function ReplaceConfirmGate({
  op,
  targetAddress,
  value,
  onChange,
}: ReplaceConfirmGateProps): JSX.Element | null {
  if (!isReplaceOp(op)) return null;
  const type = op.target.resourceType;
  const noun = nounForType(type);
  const consequence = consequencesFor(type);
  const touched = value.trim().length > 0;
  const matched = replaceConfirmMet(op, targetAddress, value);

  return (
    <section
      className={`rq-ack rq-danger${touched && !matched ? ' rq-ack--error' : ''}`}
      role="alert"
      aria-labelledby="rq-danger-title"
    >
      <h2 id="rq-danger-title" className="rq-danger__title">
        <span aria-hidden="true">⚠ </span>
        Danger: this destroys and recreates a live {noun}
      </h2>
      <p className="rq-danger__lede">
        Applying this does not change the {noun} in place. Terraform destroys{' '}
        <code>{targetAddress}</code> and builds a new one to take its place.
      </p>

      {consequence ? (
        <div className="rq-danger__consequence" role="note">
          <p className="rq-danger__consequence-head">
            {consequence.headline}
            {consequence.destroysData && (
              <span className="rq-danger__data-badge"> Data inside is destroyed.</span>
            )}
          </p>
          <ul className="rq-danger__consequence-list">
            {consequence.consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="rq-danger__generic">
          The current {noun} is torn down and a new one is built in its place. Its identity, and
          anything held only on the existing resource, does not carry over on its own — check what
          points at it before you continue.
        </p>
      )}

      <p className="rq-danger__approvals">
        Because it replaces a live resource, this needs <strong>two senior approvals</strong>, and
        nothing applies until both are in.
      </p>

      <label className="rq-ack__label rq-danger__label" htmlFor="rq-replace-confirm">
        <span>
          To confirm you understand this replaces the resource, type its name exactly:{' '}
          <code>{targetAddress}</code>
        </span>
      </label>
      <input
        id="rq-replace-confirm"
        className="rq-danger__input"
        type="text"
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={targetAddress}
        aria-invalid={touched && !matched}
        aria-describedby="rq-replace-confirm-help"
        onChange={(e) => onChange(e.target.value)}
      />
      <p
        id="rq-replace-confirm-help"
        className={`rq-danger__help${matched ? ' rq-danger__help--ok' : ''}`}
        role="status"
      >
        {matched
          ? 'Confirmed — the name matches.'
          : touched
            ? 'That name does not match. Type the resource name exactly to continue.'
            : 'Submit stays disabled until you type the name.'}
      </p>
    </section>
  );
}
