import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { RequestStatus } from '@/types';
import {
  actionLabel,
  isPlanSummary,
  planHeadline,
  type PlanResourceChange,
  type PlanSummary,
} from '@/lib/planSummary';
import { consequencesFor, nounForType } from '@/lib/replaceConsequences';
import { allBlockSources } from '@/lib/blockSource';
import { findDependents } from '@/lib/dependents';
import { formatProjectTime } from '@/lib/datetime';
import './requests.css';

/**
 * The plain-language `terraform plan` summary (visibility):
 * what THIS request will do to the live environment, rendered before any
 * apply, on RequestDetail (the requester's view) and the approvals queue
 * (the reviewer's view). Every REPLACE carries the curated consequence panel
 * (lib/replaceConsequences.ts) plus the committed-Terraform dependency note
 * (lib/dependents.ts) — the plan proves THAT a replacement happens; the panel
 * says what is lost inside it.
 *
 * All render components are prop-driven and exported (renderToStaticMarkup
 * testability, the CoolingPanel/LinkPrPanel precedent); the ONE stateful
 * piece is {@link PlanSummaryBlock}'s dependents fetch.
 */

/** Statuses that have not reached a PR yet — the plan honestly hasn't run. */
const PRE_PR_STATUSES = new Set<RequestStatus>(['DRAFT', 'SUBMITTED', 'NEEDS_ENGINEER']);
/** Statuses where a PR/pipeline exists (or existed) but no summary landed. */
const AWAITING_PLAN_STATUSES = new Set<RequestStatus>([
  'GENERATING',
  'CHECKS_RUNNING',
  'PLAN_READY',
  'AWAITING_CODE_REVIEW',
  'CHANGES_REQUESTED',
  'CODE_APPROVED',
  'MERGED',
  'AWAITING_DEPLOY_APPROVAL',
  'APPROVED_COOLING',
  'WINDOW_EXPIRED',
  'APPLYING',
]);

/**
 * The honest empty state — never a fake summary. Null for terminal/applied
 * statuses (nothing useful to promise there).
 */
export function planPendingText(status: RequestStatus): string | null {
  if (PRE_PR_STATUSES.has(status)) {
    return 'No plan yet — Terraform runs the plan when this request becomes a PR.';
  }
  if (AWAITING_PLAN_STATUSES.has(status)) {
    return 'No plan summary recorded yet — it appears here once the PR’s plan job runs.';
  }
  return null;
}

/** Whether {@link PlanSummaryBlock} would render anything at all — callers
 * use it to skip a section heading over an empty body (e.g. a terminal
 * request with no recorded plan). */
export function hasPlanContent(status: RequestStatus, planSummary: unknown): boolean {
  return isPlanSummary(planSummary) || planPendingText(status) !== null;
}

/** One `attr: before → after` line. Values arrive pre-redacted from the
 * parser ("(sensitive)", "(known after apply)") — rendered verbatim. */
function AttrChangeRow({ attr, before, after }: { attr: string; before: string; after: string }): JSX.Element {
  return (
    <li className="plan-attr">
      <code className="plan-attr__name">{attr}</code>
      <span className="plan-attr__values">
        <span className="plan-attr__before">{before}</span>
        <span className="plan-attr__arrow" aria-hidden="true">
          {' → '}
        </span>
        <span className="plan-attr__after">{after}</span>
      </span>
    </li>
  );
}

export interface PlanResourceRowProps {
  change: PlanResourceChange;
  /** Committed-Terraform addresses referencing this one, when the scan has
   * answered: `undefined` = not scanned/loading (render nothing), `[]` =
   * scanned and clean (say so). Only replace/delete rows show it. */
  dependents?: string[];
}

/**
 * One resource in the plan — expandable; destructive rows open by default.
 *
 * The ⚠ badge, the open-by-default detail, and the dependents scan below are
 * ALL keyed off `change.action` alone — so the truthfulness of that field is
 * this panel's whole contract. `action` must already distinguish a real
 * whole-resource create/destroy from an in-place attribute/entry edit (a tag
 * add/remove is "update", never "create"/"delete") BEFORE it reaches here —
 * see `isAttributeLevelOp` (lib/diff.ts), which `mockPlanSummaryFor`
 * (lib/api.ts) keys the mock's action off. This component does not — and
 * must not — re-derive that distinction: LD-1/OP-3 were exactly a request
 * whose `action` was already wrong (a tag removal stamped "delete") sailing
 * through this same destructive rendering with no separate bug here.
 */
export function PlanResourceRow({ change, dependents }: PlanResourceRowProps): JSX.Element {
  const destructive = change.action === 'replace' || change.action === 'delete';
  const consequence = change.action === 'replace' ? consequencesFor(change.type) : undefined;
  return (
    <details className={`plan-res plan-res--${change.action}`} open={destructive}>
      <summary className="plan-res__summary">
        <span className={`plan-res__action plan-res__action--${change.action}`}>
          {destructive && (
            <span className="plan-res__warn" aria-hidden="true">
              ⚠{' '}
            </span>
          )}
          {actionLabel(change.action)}
        </span>
        <span className="plan-res__addr">{change.address}</span>
      </summary>

      {change.forcedBy && change.forcedBy.length > 0 && (
        <p className="plan-res__forced">
          Replacement forced by{' '}
          {change.forcedBy.map((attr, i) => (
            <span key={attr}>
              {i > 0 && ', '}
              <code>{attr}</code>
            </span>
          ))}{' '}
          — this attribute cannot change on the live resource, so Terraform destroys and recreates
          it.
        </p>
      )}

      {change.changed && change.changed.length > 0 && (
        <ul className="plan-res__attrs">
          {change.changed.map((c) => (
            <AttrChangeRow key={c.attr} attr={c.attr} before={c.before} after={c.after} />
          ))}
        </ul>
      )}

      {consequence && (
        <div className="plan-consequence" role="note">
          <p className="plan-consequence__head">
            {consequence.headline}
            {consequence.destroysData && (
              <span className="plan-consequence__data-badge"> Data inside is destroyed.</span>
            )}
          </p>
          <ul className="plan-consequence__list">
            {consequence.consequences.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      {destructive && dependents !== undefined && (
        <div className="plan-dependents">
          {dependents.length === 0 ? (
            <p className="plan-dependents__none">
              Nothing else in the committed Terraform references this address.
            </p>
          ) : (
            <>
              <p className="plan-dependents__head">
                Also wired to this resource in the committed Terraform — review these alongside the
                replacement:
              </p>
              <ul className="plan-dependents__list">
                {dependents.map((d) => (
                  <li key={d}>
                    <code>{d}</code>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </details>
  );
}

export interface PlanSummaryPanelProps {
  summary: PlanSummary;
  /** address → referencing addresses, for replace/delete rows (see
   * {@link PlanResourceRowProps.dependents}). */
  dependentsByAddress?: Record<string, string[]>;
}

/** The full panel: headline + expandable per-resource rows + vintage line. */
export function PlanSummaryPanel({ summary, dependentsByAddress }: PlanSummaryPanelProps): JSX.Element {
  const noop = summary.resourceChanges.length === 0;
  return (
    <div className="plan-summary">
      <p className={`plan-summary__headline${noop ? ' plan-summary__headline--noop' : ''}`}>
        {planHeadline(summary, nounForType)}
      </p>
      {summary.resourceChanges.map((change) => (
        <PlanResourceRow
          key={change.address}
          change={change}
          dependents={dependentsByAddress?.[change.address]}
        />
      ))}
      {(summary.recordedAt || summary.runUrl) && (
        <p className="plan-summary__vintage">
          {summary.recordedAt
            ? `From the CI plan recorded ${formatProjectTime(summary.recordedAt)}`
            : 'From the CI plan'}
          {summary.runUrl && (
            <>
              {' · '}
              <a href={summary.runUrl} target="_blank" rel="noreferrer">
                view the run
              </a>
            </>
          )}
          . Nothing applies until every approval is in.
        </p>
      )}
    </div>
  );
}

/** Addresses whose dependents matter: the destructive ones. */
function destructiveAddresses(summary: PlanSummary): string[] {
  return summary.resourceChanges
    .filter((c) => c.action === 'replace' || c.action === 'delete')
    .map((c) => c.address);
}

/**
 * The stateful wrapper both surfaces mount: guards non-structured legacy
 * values, renders the honest pending note when no summary exists, and scans
 * the committed blocks for dependents of every destructive address (lazily —
 * only when the summary actually replaces/deletes something).
 */
export function PlanSummaryBlock({
  status,
  planSummary,
}: {
  status: RequestStatus;
  planSummary?: unknown;
}): JSX.Element | null {
  const summary = isPlanSummary(planSummary) ? planSummary : undefined;
  const [dependentsByAddress, setDependentsByAddress] = useState<
    Record<string, string[]> | undefined
  >(undefined);

  // Serialized so the effect's dependency is a stable value, not an array
  // identity that changes per render.
  const addressesKey = summary ? destructiveAddresses(summary).join('\n') : '';

  useEffect(() => {
    if (addressesKey === '') return;
    let active = true;
    void allBlockSources().then((blocks) => {
      if (!active) return;
      const map: Record<string, string[]> = {};
      for (const address of addressesKey.split('\n')) {
        map[address] = findDependents(address, blocks);
      }
      setDependentsByAddress(map);
    });
    return () => {
      active = false;
    };
  }, [addressesKey]);

  if (!summary) {
    const pending = planPendingText(status);
    if (!pending) return null;
    return <p className="plan-summary__pending">{pending}</p>;
  }
  return <PlanSummaryPanel summary={summary} dependentsByAddress={dependentsByAddress} />;
}
