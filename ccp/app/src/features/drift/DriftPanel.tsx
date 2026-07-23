import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { DriftStatus } from '@/types/drift';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { formatProjectTime } from '@/lib/datetime';
import './drift.css';

/**
 * The drift status summary — a green/amber/grey card for the Lead
 * dashboard and the `/drift` page's own freshness banner. Every value
 * renders with its capture time adjacent, absolute + relative; an
 * unqualified "live"/"in sync" claim never appears (both are banned for
 * snapshot data). {@link DriftStatusCard} is pure and prop-driven
 * (renderToStaticMarkup-testable, no jsdom in this repo); the ONE stateful
 * piece is {@link DriftPanel}'s own fetch — the PlanSummaryPanel/
 * PlanSummaryBlock split, reused.
 */

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/**
 * Elapsed time since `iso`, rendered relative and CLAMPED AT ZERO — client
 * clock skew must never read "in 3 minutes". An unparseable timestamp
 * reads as an honest "unknown age", never as freshly-just-happened.
 */
export function driftAgeLabel(iso: string, now: number = Date.now()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return 'unknown age';
  const elapsed = Math.max(0, now - parsed);
  const hours = Math.floor(elapsed / HOUR_MS);
  const minutes = Math.floor((elapsed % HOUR_MS) / MINUTE_MS);
  if (hours === 0 && minutes === 0) return 'just now';
  if (hours === 0) return `${minutes}m ago`;
  return `${hours}h ${minutes}m ago`;
}

/**
 * Past 2x the stated cadence, a snapshot is stale: the data stays and
 * keeps rendering, but confidence has degraded and the UI must say so —
 * never a silent decay into looking current. An unparseable `capturedAt`
 * fails toward stale, never toward false freshness.
 */
export function isDriftStale(
  capturedAt: string,
  cadenceHours: number,
  now: number = Date.now(),
): boolean {
  const parsed = Date.parse(capturedAt);
  if (!Number.isFinite(parsed)) return true;
  const elapsedMs = Math.max(0, now - parsed);
  return elapsedMs > 2 * cadenceHours * HOUR_MS;
}

function pluralize(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

export type DriftTone = 'clean' | 'drifted' | 'unknown';

export interface DriftCardModel {
  tone: DriftTone;
  stale: boolean;
  headline: string;
  /** Relative age + cadence, e.g. "3h 20m ago · checked roughly every 6h".
   * `null` only for the not-connected tone (nothing to time). */
  meta: string | null;
}

/**
 * Pure derivation from a drift status to the card's copy — the spec's
 * states: connected+clean, connected+drifted, either one gone stale, and
 * not-connected, EXTENDED (out-of-band provisioning spec) with the
 * unmanaged-resource sweep's own honesty axis. `null` NEVER reads as
 * clean/green: "not connected" is its own tone so absence of data can't be
 * mistaken for absence of drift — and, one level down, a report that
 * carries no `sweep` section never reads as clean/green either: the
 * sweep's absence is never implied to be a clean sweep, so it shares the
 * SAME 'unknown' tone as not-connected (a distinct headline says which),
 * never 'clean' — UNLESS the plan itself is already dirty, in which case
 * that is the stronger, unambiguous signal and tone is 'drifted' regardless
 * of sweep status (a verified problem outranks an unmeasured one). Tone is
 * 'drifted' (amber) whenever EITHER axis is confirmed nonzero — a clean
 * plan with unmanaged findings is not a clean card — and 'clean' ONLY when
 * the plan is clean AND the sweep ran AND found nothing.
 */
export function driftCardModel(status: DriftStatus | null, now: number = Date.now()): DriftCardModel {
  if (!status) {
    return {
      tone: 'unknown',
      stale: false,
      headline: "Drift monitoring isn't connected in this deployment",
      meta: null,
    };
  }
  const { report } = status;
  const driftClean = report.planExitCode === 0;
  const swept = report.sweep !== undefined;
  const unmanagedCount = report.counts.unmanaged ?? 0;
  const stale = isDriftStale(report.capturedAt, report.cadenceHours, now);
  const abs = formatProjectTime(report.capturedAt);
  const relative = driftAgeLabel(report.capturedAt, now);
  // A dated positive claim, never an unqualified "in sync" (clean) — the
  // drifted count named alongside how much of it is security-posture, and
  // now the unmanaged-resource count alongside it too. `swept` gates
  // whether the unmanaged clause may claim a count AT ALL: "not swept" is
  // its own fixed clause, never a guessed/defaulted "0 unmanaged".
  const driftClause = driftClean
    ? 'No drift detected'
    : `${pluralize(report.counts.drifted, 'resource')} drifted, ${report.counts.security} security`;
  const unmanagedClause = !swept
    ? 'unmanaged: not swept'
    : unmanagedCount === 0
      ? 'no unmanaged resources'
      : `${pluralize(unmanagedCount, 'resource')} unmanaged`;
  const base = `${driftClause} · ${unmanagedClause} as of ${abs}`;
  // Stale leads every banner with "last checked X ago" — the data is kept
  // and shown, but confidence is what has degraded, said up front.
  const headline = stale ? `Last checked ${relative} — ${base}` : base;
  // A dirty plan is the strongest, unambiguous signal — amber regardless of
  // sweep status. Only when the plan itself is clean does the sweep axis
  // get to decide between 'unknown' (not swept — never claim clean),
  // 'drifted' (swept, found something), and 'clean' (swept, found nothing).
  const tone: DriftTone = !driftClean ? 'drifted' : !swept ? 'unknown' : unmanagedCount > 0 ? 'drifted' : 'clean';
  return {
    tone,
    stale,
    headline,
    meta: `${relative} · checked roughly every ${report.cadenceHours}h`,
  };
}

export interface DriftStatusCardProps {
  status: DriftStatus | null;
  now?: number;
}

export function DriftStatusCard({ status, now = Date.now() }: DriftStatusCardProps): JSX.Element {
  const model = driftCardModel(status, now);
  return (
    <div
      className={`drift-card drift-card--${model.tone}${model.stale ? ' drift-card--stale' : ''}`}
      role="note"
    >
      <p className="drift-card__headline">{model.headline}</p>
      {model.meta && <p className="drift-card__meta">{model.meta}</p>}
    </div>
  );
}

/**
 * The stateful dashboard widget: fetches the active project's drift status
 * once (and again on a project switch) and renders {@link DriftStatusCard}
 * plus a link into the full `/drift` page. Mounted on LeadDashboard.
 */
export function DriftPanel(): JSX.Element {
  const [status, setStatus] = useState<DriftStatus | null | undefined>(undefined);
  const projectId = useActiveProjectId();

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

  return (
    <section className="drift-panel" aria-label="Drift status">
      {status === undefined ? (
        <div className="drift-card drift-card--loading" role="note">
          <p className="drift-card__headline">Checking drift status…</p>
        </div>
      ) : (
        <DriftStatusCard status={status} />
      )}
      <Link className="drift-panel__link" to="/drift">
        View drift detail →
      </Link>
    </section>
  );
}
