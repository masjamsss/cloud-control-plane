import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Schedule } from '@/types';
import type {
  DriftAbsorbedEntry,
  DriftChangedAttr,
  DriftProposal,
  DriftReport,
  DriftStatus,
  DriftVerdict,
} from '@/types/drift';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { useCurrentUser } from '@/lib/session';
import { Badge, type BadgeColor } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { selectAll, deselectAll, allSelected, toggleSelection } from '@/lib/changeSet';
import { DriftStatusCard } from './DriftPanel';
import { driftProposalStateFor } from './driftProposalState';
import { DriftProposalChip, ProposalDrawer } from './ProposalDrawer';
import { LegitimizeDrawer } from './LegitimizeDrawer';
import { ImportDrawer } from './ImportDrawer';
import { RestoreDrawer } from './RestoreDrawer';
import { UnmanagedResourcesSection } from './UnmanagedResources';
import { ResolutionFlow, partitionForResolution } from './ResolutionFlow';
import { submitDriftProposalVia, legitimizeDriftSecurityVia } from './proposalFlow';
import {
  nextCheckState,
  nextGenerateState,
  type DriftCheckButtonState,
  type DriftGenerateButtonState,
} from './driftActionsFlow';
import { formatProjectTime } from '@/lib/datetime';
import './drift.css';

/**
 * The `/drift` route: the freshness card up top, the verdict table (open
 * to every bound role — presence is honesty; attr VALUES, security
 * evidence and the per-row proposal chip render only when the data itself
 * carries them, which is how the Requester tier stays hidden without this
 * component needing to know about roles at all), the standing
 * plan-based-detection completeness footer, and the proposal detail
 * drawer a chip opens. Every render piece below the page shell is pure and
 * prop-driven (renderToStaticMarkup-testable); the page's own fetch and
 * the drawer's open/submit state are the stateful pieces — the
 * PlanSummaryPanel/PlanSummaryBlock split, reused.
 */

/** `critical,high` → the crit token · `medium` → warn · `low` → ok ·
 * everything else (including `info` and an unrecognized tier) → neutral —
 * the existing risk-token convention (risk stays the only colored axis;
 * an unrecognized tier fails closed to neutral, never a false calm/alarm). */
const RISK_TIER_COLOR: Record<string, BadgeColor> = {
  critical: 'crit',
  high: 'crit',
  medium: 'warn',
  low: 'ok',
};

function riskTierColor(tier: string): BadgeColor {
  return RISK_TIER_COLOR[tier] ?? 'muted';
}

/** Display-only humanization; `class` itself is never re-derived or keyed
 * on beyond this label — an unrecognized id just prints with underscores
 * swapped for spaces, same as a known one. */
function classLabel(cls: string): string {
  return cls.replace(/_/g, ' ');
}

/**
 * One verdict's changed-attribute list — paths always; a `path: live →
 * code` line only when the row itself carries values (Approver+ — presence
 * IS the gate, the same doctrine as FeasibilityBanner's undefined-means-
 * nothing-to-say).
 */
export function DriftAttrList({ attrs }: { attrs: DriftChangedAttr[] | undefined }): JSX.Element | null {
  if (!attrs || attrs.length === 0) return null;
  return (
    <ul className="drift-row__attrs">
      {attrs.map((a) => (
        <li key={a.path}>
          <code>{a.path}</code>
          {a.live !== undefined && a.code !== undefined && (
            <span className="drift-row__attrval">
              {': '}
              {a.live}
              {' → '}
              {a.code}
            </span>
          )}
        </li>
      ))}
    </ul>
  );
}

export interface DriftVerdictRowProps {
  verdict: DriftVerdict;
  /** Approver+ only — absent for a Requester-projected report (the
   * field-tier rule). Drives the "Fix" cell; omitted entirely (not just
   * emptied) when this is undefined, same doctrine as every other
   * approver+ column. */
  proposals?: DriftProposal[];
  onOpenProposal?: (digest: string) => void;
  /** Opens {@link RestoreDrawer} for a restore-eligible out-of-band-deletion
   * row (drift restore tranche, L29) — a SEPARATE callback from
   * `onOpenProposal` because it opens a different drawer, mirroring how the
   * unmanaged-resources section's `onOpenImport` is its own callback. */
  onOpenRestore?: (digest: string) => void;
}

export function DriftVerdictRow({ verdict, proposals, onOpenProposal, onOpenRestore }: DriftVerdictRowProps): JSX.Element {
  const isSecurity = verdict.class === 'security_posture' || (verdict.securityHits?.length ?? 0) > 0;
  const proposalState = driftProposalStateFor(verdict, proposals);
  return (
    <tr className={isSecurity ? 'drift-row drift-row--security' : 'drift-row'}>
      <td>
        <code className="drift-row__addr">{verdict.address}</code>
        <span className="drift-row__type">{verdict.type}</span>
      </td>
      <td className="drift-row__class">{classLabel(verdict.class)}</td>
      <td>
        <Badge color={riskTierColor(verdict.riskTier)}>{verdict.riskTier}</Badge>
      </td>
      <td>
        <DriftAttrList attrs={verdict.changedAttrs} />
        {verdict.securityHits && verdict.securityHits.length > 0 && (
          <div className="drift-row__evidence">
            <Badge color="crit">security evidence</Badge>
            <ul>
              {verdict.securityHits.map((h) => (
                <li key={h.path}>{h.why}</li>
              ))}
            </ul>
          </div>
        )}
        {verdict.recommendation && <p className="drift-row__reco">{verdict.recommendation}</p>}
      </td>
      {proposals !== undefined && (
        <td className="drift-row__fix">
          <DriftProposalChip
            state={proposalState}
            onOpen={
              proposalState && (proposalState.kind === 'adopt' || proposalState.kind === 'revert')
                ? () => onOpenProposal?.(proposalState.proposal.digest)
                : proposalState && proposalState.kind === 'restore'
                  ? () => onOpenRestore?.(proposalState.proposal.digest)
                  : undefined
            }
          />
        </td>
      )}
    </tr>
  );
}

export interface DriftVerdictTableProps {
  verdicts: DriftVerdict[];
  proposals?: DriftProposal[];
  onOpenProposal?: (digest: string) => void;
  onOpenRestore?: (digest: string) => void;
}

export function DriftVerdictTable({
  verdicts,
  proposals,
  onOpenProposal,
  onOpenRestore,
}: DriftVerdictTableProps): JSX.Element {
  if (verdicts.length === 0) {
    return <p className="drift-page__empty">No drifted resources in the latest snapshot.</p>;
  }
  const showFixColumn = proposals !== undefined;
  return (
    <div className="drift-table-wrap">
      <table className="drift-table">
        <thead>
          <tr>
            <th>Resource</th>
            <th>Class</th>
            <th>Risk</th>
            <th>Changed</th>
            {showFixColumn && <th>Fix</th>}
          </tr>
        </thead>
        <tbody>
          {verdicts.map((v) => (
            <DriftVerdictRow
              key={v.address}
              verdict={v}
              proposals={proposals}
              onOpenProposal={onOpenProposal}
              onOpenRestore={onOpenRestore}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function pluralizeAbsorbed(n: number): string {
  return `${n} drift ${n === 1 ? 'entry' : 'entries'} absorbed by an existing ignore rule`;
}

export function DriftAbsorbedList({ entries }: { entries: DriftAbsorbedEntry[] }): JSX.Element | null {
  if (entries.length === 0) return null;
  return (
    <details className="drift-absorbed">
      <summary>{pluralizeAbsorbed(entries.length)}</summary>
      <ul>
        {entries.map((e) => (
          <li key={e.address}>
            <code>{e.address}</code>
          </li>
        ))}
      </ul>
    </details>
  );
}

export interface DriftReportBodyProps {
  report: DriftReport;
  proposals?: DriftProposal[];
  onOpenProposal?: (digest: string) => void;
  onOpenRestore?: (digest: string) => void;
}

/**
 * The loaded report body: table + absorbed list + the standing
 * completeness footer. Pure — takes the already-fetched report as a prop —
 * so "the footer always renders" is directly testable without mounting the
 * stateful page (renderToStaticMarkup never commits a useEffect fetch).
 */
export function DriftReportBody({ report, proposals, onOpenProposal, onOpenRestore }: DriftReportBodyProps): JSX.Element {
  return (
    <>
      <DriftVerdictTable
        verdicts={report.verdicts}
        proposals={proposals}
        onOpenProposal={onOpenProposal}
        onOpenRestore={onOpenRestore}
      />
      <DriftAbsorbedList entries={report.absorbed} />
      <p className="drift-page__footer">{report.invisibleToPlan}</p>
    </>
  );
}

export function DriftPage(): JSX.Element {
  const [status, setStatus] = useState<DriftStatus | null | undefined>(undefined);
  const projectId = useActiveProjectId();
  const navigate = useNavigate();
  const currentUser = useCurrentUser();

  // The proposal drawer: which digest is open (null = closed) plus its own
  // justification/schedule/submit-in-flight state — reset on every project
  // switch so a stale digest from a previous project's report can never be
  // submitted against this one.
  const [openDigest, setOpenDigest] = useState<string | null>(null);
  const [justification, setJustification] = useState('');
  const [schedule, setSchedule] = useState<Schedule>({ kind: 'now' });
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // "Start drift check" (B1) — its own small state machine (driftActionsFlow.ts):
  // 'disarmed' renders as a STANDING disabled-with-reason state, distinct from
  // a one-off retryable 'error'.
  const [checkState, setCheckState] = useState<DriftCheckButtonState>({ kind: 'idle' });

  // "Fix the drift" (B2): whether the resolution flow is expanded, plus the
  // generation-refresh trigger's own honest state.
  const [resolutionOpen, setResolutionOpen] = useState(false);
  const [generateState, setGenerateState] = useState<DriftGenerateButtonState>({ kind: 'idle' });

  // The adopt batch (multi-select adopts → ONE alsoDigests submit) — the
  // shared form is the SAME justification/schedule doctrine as the
  // single-proposal drawer above, just applied to a selection instead of one
  // digest.
  const [selectedAdopt, setSelectedAdopt] = useState<ReadonlySet<string>>(new Set());
  const [batchJustification, setBatchJustification] = useState('');
  const [batchSchedule, setBatchSchedule] = useState<Schedule>({ kind: 'now' });
  const [batchSubmitting, setBatchSubmitting] = useState(false);
  const [batchError, setBatchError] = useState<string | null>(null);

  // C2's own drawer (LegitimizeDrawer) — reset on every open, mirroring the
  // single-proposal drawer's own reset discipline.
  const [openLegitimizeDigest, setOpenLegitimizeDigest] = useState<string | null>(null);
  const [legitimizeJustification, setLegitimizeJustification] = useState('');
  const [legitimizeSchedule, setLegitimizeSchedule] = useState<Schedule>({ kind: 'now' });
  const [legitimizeSubmitting, setLegitimizeSubmitting] = useState(false);
  const [legitimizeError, setLegitimizeError] = useState<string | null>(null);

  // The import drawer (out-of-band provisioning spec) — the unmanaged-
  // resources section's per-row "Import proposal ready" chip opens this,
  // mirroring the verdict table's single-proposal drawer exactly (its own
  // justification/schedule/submit-in-flight state, reset on every open).
  const [openImportDigest, setOpenImportDigest] = useState<string | null>(null);
  const [importJustification, setImportJustification] = useState('');
  const [importSchedule, setImportSchedule] = useState<Schedule>({ kind: 'now' });
  const [importSubmitting, setImportSubmitting] = useState(false);
  const [importSubmitError, setImportSubmitError] = useState<string | null>(null);

  // The import batch (multi-select imports → ONE alsoDigests submit, import
  // proposals only) — the SAME shared form doctrine as the adopt batch
  // above, applied to ResolutionFlow's "Import" section.
  const [selectedImportBatch, setSelectedImportBatch] = useState<ReadonlySet<string>>(new Set());
  const [importBatchJustification, setImportBatchJustification] = useState('');
  const [importBatchSchedule, setImportBatchSchedule] = useState<Schedule>({ kind: 'now' });
  const [importBatchSubmitting, setImportBatchSubmitting] = useState(false);
  const [importBatchError, setImportBatchError] = useState<string | null>(null);

  // The restore drawer (drift restore tranche, L29) — the verdict table's
  // per-row "Restore fix generated" chip opens this, mirroring the
  // single-proposal drawer's own justification/schedule/submit-in-flight
  // state exactly (restore is verdict-keyed like adopt/revert, not
  // finding-keyed like import).
  const [openRestoreDigest, setOpenRestoreDigest] = useState<string | null>(null);
  const [restoreJustification, setRestoreJustification] = useState('');
  const [restoreSchedule, setRestoreSchedule] = useState<Schedule>({ kind: 'now' });
  const [restoreSubmitting, setRestoreSubmitting] = useState(false);
  const [restoreSubmitError, setRestoreSubmitError] = useState<string | null>(null);

  // The restore batch (multi-select restores → ONE alsoDigests submit,
  // restore proposals only) — the SAME shared form doctrine as the adopt/
  // import batches above, applied to ResolutionFlow's "Restore" section.
  const [selectedRestoreBatch, setSelectedRestoreBatch] = useState<ReadonlySet<string>>(new Set());
  const [restoreBatchJustification, setRestoreBatchJustification] = useState('');
  const [restoreBatchSchedule, setRestoreBatchSchedule] = useState<Schedule>({ kind: 'now' });
  const [restoreBatchSubmitting, setRestoreBatchSubmitting] = useState(false);
  const [restoreBatchError, setRestoreBatchError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setStatus(undefined);
    void api.getDriftStatus().then((s) => {
      if (active) setStatus(s);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  useEffect(() => {
    setOpenDigest(null);
    setJustification('');
    setSchedule({ kind: 'now' });
    setSubmitError(null);
    // A stale digest/selection from a previous project's report can never be
    // acted on against this one — reset every drift-page control on switch,
    // same doctrine as the single-proposal drawer above.
    setCheckState({ kind: 'idle' });
    setResolutionOpen(false);
    setGenerateState({ kind: 'idle' });
    setSelectedAdopt(new Set());
    setBatchJustification('');
    setBatchSchedule({ kind: 'now' });
    setBatchError(null);
    setOpenLegitimizeDigest(null);
    setLegitimizeJustification('');
    setLegitimizeSchedule({ kind: 'now' });
    setLegitimizeError(null);
    // A stale import digest/selection from a previous project's report can
    // never be acted on against this one either — same reset discipline.
    setOpenImportDigest(null);
    setImportJustification('');
    setImportSchedule({ kind: 'now' });
    setImportSubmitError(null);
    setSelectedImportBatch(new Set());
    setImportBatchJustification('');
    setImportBatchSchedule({ kind: 'now' });
    setImportBatchError(null);
    // A stale restore digest/selection from a previous project's report can
    // never be acted on against this one either — same reset discipline.
    setOpenRestoreDigest(null);
    setRestoreJustification('');
    setRestoreSchedule({ kind: 'now' });
    setRestoreSubmitError(null);
    setSelectedRestoreBatch(new Set());
    setRestoreBatchJustification('');
    setRestoreBatchSchedule({ kind: 'now' });
    setRestoreBatchError(null);
  }, [projectId]);

  const openProposal =
    openDigest && status?.proposals ? status.proposals.find((p) => p.digest === openDigest) : undefined;
  const openVerdict =
    openProposal && status
      ? status.report.verdicts.find((v) => openProposal.addresses.includes(v.address))
      : undefined;

  const openLegitimizeProposal =
    openLegitimizeDigest && status?.proposals
      ? status.proposals.find((p) => p.digest === openLegitimizeDigest)
      : undefined;
  const openLegitimizeVerdict =
    openLegitimizeProposal && status
      ? status.report.verdicts.find((v) => openLegitimizeProposal.addresses.includes(v.address))
      : undefined;

  // The import drawer's own proposal/finding pair — a finding has no
  // Terraform address to key on (unlike a verdict), so the match runs on
  // `arn` instead, the SAME identity findingProposalStateFor already keys
  // on (driftProposalState.ts).
  const openImportProposal =
    openImportDigest && status?.proposals ? status.proposals.find((p) => p.digest === openImportDigest) : undefined;
  const openImportFinding =
    openImportProposal && status
      ? status.report.sweep?.findings.find((f) => f.arn === openImportProposal.arn)
      : undefined;

  // The restore drawer's own proposal/verdict pair — restore is
  // verdict-keyed, exactly like the single-proposal drawer's
  // openProposal/openVerdict above (drift restore tranche, L29).
  const openRestoreProposal =
    openRestoreDigest && status?.proposals
      ? status.proposals.find((p) => p.digest === openRestoreDigest)
      : undefined;
  const openRestoreVerdict =
    openRestoreProposal && status
      ? status.report.verdicts.find((v) => openRestoreProposal.addresses.includes(v.address))
      : undefined;

  // Lead/admin only — the same role rule B1/B2 enforce server-side
  // (roleFor === 'lead' || account.isAdmin === true, the apply-route
  // precedent). Hidden rather than disabled-and-explained for a role that
  // can never use them: these are operator actions, not something every
  // bound member is expected to reach for (mirrors how admin-only controls
  // are hidden elsewhere in this app, not merely disabled).
  const canOperateDrift = currentUser.role === 'lead' || currentUser.isAdmin === true;
  // Revert/legitimize stay approver/lead-gated even inside an
  // operator-only view (an admin account can hold role:'requester') — the
  // SAME rule ProposalDrawer's canSubmit already mirrors for revert.
  const canRevertOrLegitimize = currentUser.role === 'approver' || currentUser.role === 'lead';

  const partition =
    status && status.proposals
      ? partitionForResolution(status.report.verdicts, status.proposals, status.report.sweep?.findings)
      : null;
  const adoptDigests = partition ? partition.adopt.map((c) => c.proposal.digest) : [];
  const importDigests = partition ? (partition.importEligible ?? []).map((c) => c.proposal.digest) : [];
  const restoreDigests = partition ? partition.restore.map((c) => c.proposal.digest) : [];

  const handleStartCheck = (): void => {
    setCheckState({ kind: 'requesting' });
    void api.startDriftCheck(projectId).then((result) => {
      setCheckState(nextCheckState(result));
      if (result.ok) {
        // Mock parity: a triggered check "completes" immediately in mock
        // mode, so re-fetching now shows it; in a real deployment this is a
        // harmless no-op re-fetch (the report lands later, through the
        // normal ingest PUT — the status card's own staleness display
        // covers arrival).
        void api.getDriftStatus().then(setStatus);
      }
    });
  };

  const handleFixTheDrift = (): void => {
    if (resolutionOpen) {
      setResolutionOpen(false);
      return;
    }
    setResolutionOpen(true);
    handleGenerate();
  };

  const handleGenerate = (): void => {
    setGenerateState({ kind: 'generating' });
    void api.generateDriftProposals(projectId).then((result) => {
      setGenerateState(nextGenerateState(result));
      if (result.ok) {
        void api.getDriftStatus().then(setStatus);
        // A refresh can supersede a previously-open proposal — drop any
        // selection made before this run rather than risk a stale digest
        // that no longer matches an open adopt row (the submit path would
        // refuse it cleanly either way, but this keeps the shown count
        // honest without waiting on that round trip).
        setSelectedAdopt(new Set());
        setSelectedImportBatch(new Set());
        setSelectedRestoreBatch(new Set());
      }
    });
  };

  const handleToggleAdopt = (digest: string): void => {
    setSelectedAdopt((prev) => toggleSelection(prev, digest));
  };
  const handleToggleSelectAllAdopt = (): void => {
    setSelectedAdopt((prev) =>
      allSelected(prev, adoptDigests) ? deselectAll(prev, adoptDigests) : selectAll(prev, adoptDigests),
    );
  };
  const handleSubmitBatch = (): void => {
    if (selectedAdopt.size === 0) return;
    const [primary, ...rest] = [...selectedAdopt];
    if (!primary) return;
    setBatchSubmitting(true);
    setBatchError(null);
    void submitDriftProposalVia(api, (path) => navigate(path), primary, {
      justification: batchJustification,
      schedule: batchSchedule,
      alsoDigests: rest,
    }).then((result) => {
      if (!result.ok) {
        setBatchSubmitting(false);
        setBatchError(result.reason);
      }
      // On success submitDriftProposalVia already navigated away.
    });
  };

  const handleChooseLegitimize = (digest: string): void => {
    setOpenLegitimizeDigest(digest);
    setLegitimizeJustification('');
    setLegitimizeSchedule({ kind: 'now' });
    setLegitimizeError(null);
  };
  const handleCloseLegitimizeDrawer = (): void => setOpenLegitimizeDigest(null);
  const handleSubmitLegitimize = (): void => {
    if (!openLegitimizeDigest) return;
    setLegitimizeSubmitting(true);
    setLegitimizeError(null);
    void legitimizeDriftSecurityVia(api, (path) => navigate(path), openLegitimizeDigest, {
      justification: legitimizeJustification,
      schedule: legitimizeSchedule,
    }).then((result) => {
      if (!result.ok) {
        setLegitimizeSubmitting(false);
        setLegitimizeError(result.reason);
      }
    });
  };

  const handleOpenProposal = (digest: string): void => {
    setOpenDigest(digest);
    setJustification('');
    setSchedule({ kind: 'now' });
    setSubmitError(null);
  };
  const handleCloseDrawer = (): void => setOpenDigest(null);

  const handleSubmit = (): void => {
    if (!openProposal) return;
    setSubmitting(true);
    setSubmitError(null);
    void submitDriftProposalVia(api, (path) => navigate(path), openProposal.digest, {
      justification,
      schedule,
    }).then((result) => {
      if (!result.ok) {
        setSubmitting(false);
        setSubmitError(result.reason);
      }
      // On success submitDriftProposalVia already navigated away.
    });
  };

  // The unmanaged-resources section's per-row chip — a single import
  // submit, mirroring handleOpenProposal/handleSubmit above exactly (the
  // same submitDriftProposalVia seam handles every flavor identically).
  const handleOpenImport = (digest: string): void => {
    setOpenImportDigest(digest);
    setImportJustification('');
    setImportSchedule({ kind: 'now' });
    setImportSubmitError(null);
  };
  const handleCloseImportDrawer = (): void => setOpenImportDigest(null);
  const handleSubmitImport = (): void => {
    if (!openImportProposal) return;
    setImportSubmitting(true);
    setImportSubmitError(null);
    void submitDriftProposalVia(api, (path) => navigate(path), openImportProposal.digest, {
      justification: importJustification,
      schedule: importSchedule,
    }).then((result) => {
      if (!result.ok) {
        setImportSubmitting(false);
        setImportSubmitError(result.reason);
      }
      // On success submitDriftProposalVia already navigated away.
    });
  };

  // ResolutionFlow's "Import" batch section — the SAME multi-select →
  // alsoDigests submit shape as the adopt batch above, scoped to import
  // proposals only (the api refuses a mixed-flavor batch regardless).
  const handleToggleImportBatch = (digest: string): void => {
    setSelectedImportBatch((prev) => toggleSelection(prev, digest));
  };
  const handleToggleSelectAllImportBatch = (): void => {
    setSelectedImportBatch((prev) =>
      allSelected(prev, importDigests) ? deselectAll(prev, importDigests) : selectAll(prev, importDigests),
    );
  };
  const handleSubmitImportBatch = (): void => {
    if (selectedImportBatch.size === 0) return;
    const [primary, ...rest] = [...selectedImportBatch];
    if (!primary) return;
    setImportBatchSubmitting(true);
    setImportBatchError(null);
    void submitDriftProposalVia(api, (path) => navigate(path), primary, {
      justification: importBatchJustification,
      schedule: importBatchSchedule,
      alsoDigests: rest,
    }).then((result) => {
      if (!result.ok) {
        setImportBatchSubmitting(false);
        setImportBatchError(result.reason);
      }
      // On success submitDriftProposalVia already navigated away.
    });
  };

  // The verdict table's per-row "Restore fix generated" chip — a single
  // restore submit, mirroring handleOpenProposal/handleSubmit above exactly
  // (drift restore tranche, L29; the same submitDriftProposalVia seam
  // handles every flavor identically).
  const handleOpenRestore = (digest: string): void => {
    setOpenRestoreDigest(digest);
    setRestoreJustification('');
    setRestoreSchedule({ kind: 'now' });
    setRestoreSubmitError(null);
  };
  const handleCloseRestoreDrawer = (): void => setOpenRestoreDigest(null);
  const handleSubmitRestore = (): void => {
    if (!openRestoreProposal) return;
    setRestoreSubmitting(true);
    setRestoreSubmitError(null);
    void submitDriftProposalVia(api, (path) => navigate(path), openRestoreProposal.digest, {
      justification: restoreJustification,
      schedule: restoreSchedule,
    }).then((result) => {
      if (!result.ok) {
        setRestoreSubmitting(false);
        setRestoreSubmitError(result.reason);
      }
      // On success submitDriftProposalVia already navigated away.
    });
  };

  // ResolutionFlow's "Restore" batch section — the SAME multi-select →
  // alsoDigests submit shape as the adopt/import batches above, scoped to
  // restore proposals only (the api refuses a mixed-flavor batch
  // regardless).
  const handleToggleRestoreBatch = (digest: string): void => {
    setSelectedRestoreBatch((prev) => toggleSelection(prev, digest));
  };
  const handleToggleSelectAllRestoreBatch = (): void => {
    setSelectedRestoreBatch((prev) =>
      allSelected(prev, restoreDigests) ? deselectAll(prev, restoreDigests) : selectAll(prev, restoreDigests),
    );
  };
  const handleSubmitRestoreBatch = (): void => {
    if (selectedRestoreBatch.size === 0) return;
    const [primary, ...rest] = [...selectedRestoreBatch];
    if (!primary) return;
    setRestoreBatchSubmitting(true);
    setRestoreBatchError(null);
    void submitDriftProposalVia(api, (path) => navigate(path), primary, {
      justification: restoreBatchJustification,
      schedule: restoreBatchSchedule,
      alsoDigests: rest,
    }).then((result) => {
      if (!result.ok) {
        setRestoreBatchSubmitting(false);
        setRestoreBatchError(result.reason);
      }
      // On success submitDriftProposalVia already navigated away.
    });
  };

  return (
    <div className="drift-page">
      <header className="drift-page__head">
        <p className="page-eyebrow">Estate health</p>
        <h1 className="drift-page__title">Drift</h1>
        <p className="drift-page__subtitle">
          What the scheduled Terraform check last found live in the account, compared with the
          code it should match.
        </p>
      </header>

      {status === undefined ? (
        <p className="drift-page__loading">Loading…</p>
      ) : (
        <>
          <DriftStatusCard status={status} />

          {status && canOperateDrift && (
            <div className="drift-page__actions">
              <div className="drift-page__action">
                <Button
                  variant="ghost"
                  onClick={handleStartCheck}
                  disabled={checkState.kind === 'requesting' || checkState.kind === 'disarmed'}
                >
                  {checkState.kind === 'requesting' ? 'Requesting…' : 'Start drift check'}
                </Button>
                <p className="drift-page__action-help">
                  Runs the estate&apos;s drift check now instead of waiting for the next scheduled run. This
                  only starts it — the report lands here once the check publishes.
                </p>
                {checkState.kind === 'requested' && (
                  <p className="drift-page__action-status" role="status">
                    Check requested at {formatProjectTime(checkState.at)} — the report lands here once the
                    workflow publishes.
                  </p>
                )}
                {checkState.kind === 'disarmed' && (
                  <p className="drift-page__action-status drift-page__action-status--disarmed" role="note">
                    {checkState.reason}
                  </p>
                )}
                {checkState.kind === 'error' && (
                  <p className="drift-page__action-status drift-page__action-status--error" role="alert">
                    {checkState.reason}
                  </p>
                )}
              </div>

              <div className="drift-page__action">
                {/* Closing an already-open view is always allowed, even once a
                    refresh attempt inside this session came back disarmed —
                    only the OPEN/refresh action itself is disabled-with-reason;
                    the toggle must never trap the view open. */}
                <Button
                  variant="ghost"
                  onClick={handleFixTheDrift}
                  disabled={
                    generateState.kind === 'generating' ||
                    (generateState.kind === 'disarmed' && !resolutionOpen)
                  }
                >
                  {generateState.kind === 'generating'
                    ? 'Refreshing…'
                    : resolutionOpen
                      ? 'Hide the fix-the-drift view'
                      : 'Fix the drift'}
                </Button>
                <p className="drift-page__action-help">
                  Refreshes generated fixes for the current report, then opens the resolution view below —
                  batch-adopt the benign rows, or choose revert/legitimize for security-posture rows. Nothing
                  here submits or applies anything by itself; every fix still goes through the normal request
                  ladder.
                </p>
                {generateState.kind === 'generating' && (
                  <p className="drift-page__action-status" role="status">
                    Refreshing generated fixes…
                  </p>
                )}
                {generateState.kind === 'disarmed' && (
                  <p className="drift-page__action-status drift-page__action-status--disarmed" role="note">
                    {generateState.reason}
                  </p>
                )}
                {generateState.kind === 'error' && (
                  <p className="drift-page__action-status drift-page__action-status--error" role="alert">
                    {generateState.reason}
                  </p>
                )}
              </div>
            </div>
          )}

          {status && (
            <DriftReportBody
              report={status.report}
              proposals={status.proposals}
              onOpenProposal={handleOpenProposal}
              onOpenRestore={handleOpenRestore}
            />
          )}

          {status && (
            <UnmanagedResourcesSection
              report={status.report}
              proposals={status.proposals}
              onOpenImport={handleOpenImport}
            />
          )}

          {resolutionOpen && status && partition && (
            <ResolutionFlow
              partition={partition}
              selectedAdopt={selectedAdopt}
              allAdoptSelected={allSelected(selectedAdopt, adoptDigests)}
              onToggleAdopt={handleToggleAdopt}
              onToggleSelectAllAdopt={handleToggleSelectAllAdopt}
              batchJustification={batchJustification}
              onBatchJustificationChange={setBatchJustification}
              batchSchedule={batchSchedule}
              onBatchScheduleChange={setBatchSchedule}
              onSubmitBatch={handleSubmitBatch}
              batchSubmitting={batchSubmitting}
              batchError={batchError}
              onChooseRevert={handleOpenProposal}
              onChooseLegitimize={handleChooseLegitimize}
              canRevertOrLegitimize={canRevertOrLegitimize}
              selectedRestore={selectedRestoreBatch}
              allRestoreSelected={allSelected(selectedRestoreBatch, restoreDigests)}
              onToggleRestore={handleToggleRestoreBatch}
              onToggleSelectAllRestore={handleToggleSelectAllRestoreBatch}
              restoreBatchJustification={restoreBatchJustification}
              onRestoreBatchJustificationChange={setRestoreBatchJustification}
              restoreBatchSchedule={restoreBatchSchedule}
              onRestoreBatchScheduleChange={setRestoreBatchSchedule}
              onSubmitRestoreBatch={handleSubmitRestoreBatch}
              restoreBatchSubmitting={restoreBatchSubmitting}
              restoreBatchError={restoreBatchError}
              // Same role predicate as revert/legitimize/import today
              // (restore is the revert posture, not adopt's) — passed under
              // its own prop name for clarity at the ResolutionFlow call
              // site.
              canRestore={canRevertOrLegitimize}
              selectedImport={selectedImportBatch}
              allImportSelected={allSelected(selectedImportBatch, importDigests)}
              onToggleImport={handleToggleImportBatch}
              onToggleSelectAllImport={handleToggleSelectAllImportBatch}
              importBatchJustification={importBatchJustification}
              onImportBatchJustificationChange={setImportBatchJustification}
              importBatchSchedule={importBatchSchedule}
              onImportBatchScheduleChange={setImportBatchSchedule}
              onSubmitImportBatch={handleSubmitImportBatch}
              importBatchSubmitting={importBatchSubmitting}
              importBatchError={importBatchError}
              // Same role predicate as revert/legitimize today (import is
              // the revert posture, not adopt's) — passed under its own
              // prop name for clarity at the ResolutionFlow call site.
              canImport={canRevertOrLegitimize}
            />
          )}
        </>
      )}

      {openProposal && openVerdict && (
        <ProposalDrawer
          verdict={openVerdict}
          proposal={openProposal}
          justification={justification}
          onJustificationChange={setJustification}
          schedule={schedule}
          onScheduleChange={setSchedule}
          onSubmit={handleSubmit}
          onClose={handleCloseDrawer}
          submitting={submitting}
          error={submitError}
          canSubmit={
            openProposal.flavor === 'adopt' || currentUser.role === 'approver' || currentUser.role === 'lead'
          }
        />
      )}

      {openLegitimizeProposal && openLegitimizeVerdict && (
        <LegitimizeDrawer
          verdict={openLegitimizeVerdict}
          proposal={openLegitimizeProposal}
          justification={legitimizeJustification}
          onJustificationChange={setLegitimizeJustification}
          schedule={legitimizeSchedule}
          onScheduleChange={setLegitimizeSchedule}
          onSubmit={handleSubmitLegitimize}
          onClose={handleCloseLegitimizeDrawer}
          submitting={legitimizeSubmitting}
          error={legitimizeError}
          canSubmit={canRevertOrLegitimize}
        />
      )}

      {openImportProposal && openImportFinding && (
        <ImportDrawer
          finding={openImportFinding}
          proposal={openImportProposal}
          justification={importJustification}
          onJustificationChange={setImportJustification}
          schedule={importSchedule}
          onScheduleChange={setImportSchedule}
          onSubmit={handleSubmitImport}
          onClose={handleCloseImportDrawer}
          submitting={importSubmitting}
          error={importSubmitError}
          canSubmit={canRevertOrLegitimize}
        />
      )}

      {openRestoreProposal && openRestoreVerdict && (
        <RestoreDrawer
          verdict={openRestoreVerdict}
          proposal={openRestoreProposal}
          justification={restoreJustification}
          onJustificationChange={setRestoreJustification}
          schedule={restoreSchedule}
          onScheduleChange={setRestoreSchedule}
          onSubmit={handleSubmitRestore}
          onClose={handleCloseRestoreDrawer}
          submitting={restoreSubmitting}
          error={restoreSubmitError}
          canSubmit={canRevertOrLegitimize}
        />
      )}
    </div>
  );
}
