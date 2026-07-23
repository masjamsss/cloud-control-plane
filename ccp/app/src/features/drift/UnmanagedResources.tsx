import type { JSX } from 'react';
import type { DriftFinding, DriftProposal, DriftReport, DriftSweepCoverage } from '@/types/drift';
import { config } from '@/config';
import { Badge } from '@/components/ui/Badge';
import { formatProjectTime } from '@/lib/datetime';
import { findingProposalStateFor, type FindingProposalState } from './driftProposalState';
import './drift.css';

/**
 * The "Unmanaged resources" section (out-of-band provisioning spec): the
 * account-wide sweep's findings, rendered under the verdict table. A
 * finding is a live resource with NO Terraform address — the drift check
 * above can never see it on its own (the standing footer on every row says
 * so). Pure/prop-driven (renderToStaticMarkup-testable, no jsdom in this
 * repo) — DriftPage owns the one stateful piece (which import digest's
 * drawer is open); this module only renders the list + the per-row choice.
 */

/** A real, working link into the runbook's out-of-band-creation section —
 * "a link, never a button" (the standing footer's own wording): this is
 * never a clickable action, only a pointer to the documented human
 * decision. Built from project config (never a literal owner/repo), the
 * SAME doctrine every other GitHub link in this app already follows
 * (lib/api.ts's prUrl). */
export function runbookD5Url(): string {
  return `https://github.com/${config.github.owner}/${config.github.repo}/blob/main/docs/runbooks/drift-detection.md#d5--out-of-band-creation-unmanaged-resources`;
}

/** The standing footer every finding's detail view carries, verbatim —
 * exported so DriftPage/ImportDrawer/tests can all pin the exact same
 * text, mirroring how ProposalDrawer exports DRIFT_BLAST_RADIUS_NOTE for
 * the same reason. */
export function UnmanagedFooter(): JSX.Element {
  return (
    <p className="unmanaged-row__footer" role="note">
      The other resolution — delete in AWS — is a human action with owner sign-off; see{' '}
      <a href={runbookD5Url()} target="_blank" rel="noreferrer">
        runbook D5
      </a>
      .
    </p>
  );
}

function actorSummary(finding: DriftFinding): string | null {
  if (finding.actor === undefined) return null; // Requester tier — evidence is not this tier's to see
  if (finding.actor === null) return 'No CloudTrail match found yet — the evidence lookup duty is still open.';
  return `${finding.actor.eventName} — ${formatProjectTime(finding.actor.eventTime)}`;
}

export interface UnmanagedFindingChipProps {
  state: FindingProposalState | null;
  onOpen?: () => void;
}

/**
 * The section's per-row chip — one of the spec's four states. Only
 * `import` is clickable (there is a proposal to show detail for); the
 * other three render a plain, non-interactive Badge, mirroring
 * DriftProposalChip's own ungenerable/not-armed convention EXACTLY. This
 * is what makes "a security-family finding has no import affordance in
 * the DOM" structurally true, not just visually true: `creation_security`
 * can never reach the clickable branch below, by construction — see
 * driftProposalState.ts's findingProposalStateFor for why that holds even
 * under a forged/stale `flavor: 'import'` proposal row.
 */
export function UnmanagedFindingChip({ state, onOpen }: UnmanagedFindingChipProps): JSX.Element | null {
  if (state === null) return null;
  if (state.kind === 'import') {
    return (
      <button type="button" className="drift-fix-btn" onClick={onOpen}>
        <Badge color="ok">Import proposal ready</Badge>
      </button>
    );
  }
  if (state.kind === 'creation_security') {
    return (
      <Badge color="crit" title={state.reason}>
        Security family — investigate first
      </Badge>
    );
  }
  if (state.kind === 'type_unmapped' || state.kind === 'payload_withheld' || state.kind === 'ungenerable') {
    return (
      <Badge color="muted" title={state.reason}>
        {`No mechanical import — ${state.reason}`}
      </Badge>
    );
  }
  return (
    <Badge color="muted" title="An import-eligible-looking finding was not generated for this deployment.">
      generation not armed
    </Badge>
  );
}

export interface UnmanagedFindingRowProps {
  finding: DriftFinding;
  /** Approver+ only (the same field-tier rule as everywhere else on this
   * page) — absent entirely for a Requester-projected report. */
  proposals?: DriftProposal[];
  onOpenImport?: (digest: string) => void;
}

/**
 * One finding row: type, name, service, the actor summary (Approver+ —
 * presence follows duty, same doctrine as every other approver+ field on
 * this page), and exactly one state chip. Non-import states additionally
 * expand (a native `<details>` disclosure, the SAME pattern
 * DriftAbsorbedList already uses in DriftPage.tsx) into the reason plus
 * the standing footer — an import-eligible row skips this in favor of the
 * full ImportDrawer, which carries the SAME footer, so every row's detail
 * view carries it somewhere.
 */
export function UnmanagedFindingRow({ finding, proposals, onOpenImport }: UnmanagedFindingRowProps): JSX.Element {
  const state = findingProposalStateFor(finding, proposals);
  const summary = actorSummary(finding);
  return (
    <li className={finding.securityFamily ? 'unmanaged-row unmanaged-row--security' : 'unmanaged-row'}>
      <div className="unmanaged-row__main">
        <div className="unmanaged-row__identity">
          <code className="unmanaged-row__type">{finding.tfType || 'unmapped type'}</code>
          <span className="unmanaged-row__name">{finding.name}</span>
          <span className="unmanaged-row__service">{finding.service}</span>
        </div>
        {summary && <p className="unmanaged-row__actor">{summary}</p>}
      </div>
      {state && (
        <div className="unmanaged-row__chip">
          <UnmanagedFindingChip
            state={state}
            onOpen={state.kind === 'import' ? () => onOpenImport?.(state.proposal.digest) : undefined}
          />
        </div>
      )}
      {state && state.kind !== 'import' && (
        <details className="unmanaged-row__details">
          <summary>Details</summary>
          <p className="unmanaged-row__reason">
            {state.kind === 'not-armed'
              ? 'This finding looks import-eligible, but no import proposal has been generated for it on this deployment yet — an eligible-looking finding with no matching proposal most likely means import generation is not armed here.'
              : state.reason}
          </p>
          <UnmanagedFooter />
        </details>
      )}
    </li>
  );
}

function CoverageNote({ coverage }: { coverage: DriftSweepCoverage | undefined }): JSX.Element | null {
  const entries = Object.entries(coverage?.unrecognizedArnFamilies ?? {});
  if (entries.length === 0) return null;
  return (
    <p className="unmanaged__coverage">
      Also sighted at the family level only, outside the sweep&apos;s instance-level types (not diffed
      resource-by-resource):{' '}
      {entries.map(([family, count]) => `${family} (${count})`).join(', ')}. Extending instance-level coverage to
      a family is a data change, not a redesign.
    </p>
  );
}

export interface UnmanagedResourcesSectionProps {
  report: DriftReport;
  proposals?: DriftProposal[];
  onOpenImport?: (digest: string) => void;
}

/**
 * The section itself. Three honest states: no `sweep` at all (this
 * deployment has never armed or run the sweep — rendered distinctly from
 * "swept and clean," never implying the estate holds no unmanaged
 * resources), a swept report with zero findings (the genuine clean state,
 * dated), and a swept report with findings (the list). The "not swept"
 * wording here matches DriftPanel's own — one honest story, stated twice
 * because it renders in two places.
 */
export function UnmanagedResourcesSection({
  report,
  proposals,
  onOpenImport,
}: UnmanagedResourcesSectionProps): JSX.Element {
  const sweep = report.sweep;
  return (
    <section className="unmanaged" aria-label="Unmanaged resources">
      <header className="unmanaged__head">
        <h2 className="unmanaged__title">Unmanaged resources</h2>
        <p className="unmanaged__help" id="unmanaged-help">
          What the account-wide sweep found live in the account but not in Terraform state or code — the drift
          check above can never see these on its own. Each row names what can be done about it; nothing here
          writes to AWS.
        </p>
      </header>

      {!sweep ? (
        <p className="unmanaged__not-swept" role="note">
          Unmanaged resources: not swept. This deployment has not run (or has not armed) the account-wide sweep
          — that is not evidence the estate holds none; see{' '}
          <a href={runbookD5Url()} target="_blank" rel="noreferrer">
            runbook D5
          </a>
          .
        </p>
      ) : sweep.findings.length === 0 ? (
        <p className="unmanaged__empty">
          No unmanaged resources found as of {formatProjectTime(sweep.capturedAt)} ({sweep.totalFindings} total
          · {sweep.ignoredCount} ignored by a reviewed rule).
        </p>
      ) : (
        <>
          <p className="unmanaged__meta">
            {sweep.totalFindings} found as of {formatProjectTime(sweep.capturedAt)} · {sweep.ignoredCount} ignored
            by a reviewed rule.
          </p>
          <ul className="unmanaged__list" aria-describedby="unmanaged-help">
            {sweep.findings.map((f, i) => (
              <UnmanagedFindingRow
                key={f.arn ?? `${f.tfType || 'unmapped'}:${f.name}:${i}`}
                finding={f}
                proposals={proposals}
                onOpenImport={onOpenImport}
              />
            ))}
          </ul>
          <CoverageNote coverage={sweep.coverage} />
        </>
      )}
    </section>
  );
}
