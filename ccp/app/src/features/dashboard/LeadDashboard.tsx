import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import type { ChangeRequest, RequestStatus, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { attempt } from '@/lib/asyncGuard';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { getTeam, useTeams } from '@/lib/teams';
import { resolveName } from '@/lib/accounts';
import { getOperation } from '@/lib/interpreter';
import { getServiceMeta } from '@/lib/serviceMeta';
import { formatProjectDate } from '@/lib/datetime';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { DriftPanel } from '@/features/drift/DriftPanel';
import { LoadError } from '@/components/LoadError';
import { DEFAULT_WINDOW_SIZE, windowSlice } from '@/lib/windowing';
import './dashboard.css';

function userName(id: string): string {
  return resolveName(id);
}

function teamName(id: string | undefined): string {
  if (!id) return '—';
  return getTeam(id)?.name ?? id;
}

/** Statuses that count as "awaiting review" for the summary tile. */
const AWAITING = new Set<RequestStatus>([
  'AWAITING_CODE_REVIEW',
  'CHANGES_REQUESTED',
  'AWAITING_DEPLOY_APPROVAL',
]);

type TeamFilter = 'all' | string;
type StatusFilter = 'all' | RequestStatus;

/** A Ledger stat block — one cell in the summary strip (contract #4: big
 * tabular mono numbers, small mono muted label). The tone dot echoes the old
 * tile's left-border color cue without reintroducing a boxed card. */
function Tile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'neutral' | 'wait' | 'done' | 'fail';
}): JSX.Element {
  return (
    <div className={`dash-stat dash-stat--${tone}`}>
      <span className="dash-stat__value">{value}</span>
      <span className="dash-stat__label">
        <span className="dash-stat__dot" aria-hidden="true" />
        {label}
      </span>
    </div>
  );
}

function ApprovalsCell({ request }: { request: ChangeRequest }): JSX.Element {
  const required = request.approvalsRequired ?? 1;
  const approvals = request.approvals ?? [];
  const names = approvals.map((a) => userName(a.user)).join(', ');
  return (
    <span className="dash-approvals">
      <span className="dash-approvals__count">
        {approvals.length}/{required}
      </span>
      {names && <span className="dash-approvals__who">{names}</span>}
    </span>
  );
}

export function LeadDashboard(): JSX.Element {
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);
  const [team, setTeam] = useState<TeamFilter>('all');
  const [status, setStatus] = useState<StatusFilter>('all');
  // Live — a team created/renamed elsewhere fills this filter
  // dropdown without a navigation.
  const teams = useTeams();
  const projectId = useActiveProjectId();

  useEffect(() => {
    let active = true;
    setLoadError(null);
    // FE-2/UI-1: listAllRequests throws on any non-2xx in api mode, so the
    // success-only `.then` left the Lead's dashboard on "Loading…" for ever.
    void attempt(() => Promise.all([api.listAllRequests(), api.listManifests()])).then(
      (outcome) => {
        if (!active) return;
        if (!outcome.ok) {
          setLoadError(outcome.reason);
          setLoading(false);
          return;
        }
        const [r, m] = outcome.value;
        setRequests(r);
        setManifests(m);
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [projectId, reloadToken]);

  const summary = useMemo(() => {
    let awaiting = 0;
    let applied = 0;
    let rejected = 0;
    for (const r of requests) {
      if (AWAITING.has(r.status)) awaiting += 1;
      else if (r.status === 'APPLIED') applied += 1;
      else if (r.status === 'REJECTED') rejected += 1;
    }
    return { total: requests.length, awaiting, applied, rejected };
  }, [requests]);

  const statusOptions = useMemo(() => {
    const set = new Set<RequestStatus>();
    for (const r of requests) set.add(r.status);
    return [...set].sort();
  }, [requests]);

  const rows = useMemo(() => {
    return [...requests]
      .filter((r) => (team === 'all' ? true : r.teamId === team))
      .filter((r) => (status === 'all' ? true : r.status === status))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [requests, team, status]);

  // Breakdowns for the mini-charts — computed from the filtered rows so the
  // charts always reflect what the table shows. Risk is the ONLY colored axis.
  const byRisk = useMemo(() => {
    const c = { LOW: 0, MEDIUM: 0, HIGH: 0 };
    for (const r of rows) c[r.risk] += 1;
    return c;
  }, [rows]);
  const byTeam = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of rows) {
      const k = teamName(r.teamId);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);
  const maxRisk = Math.max(1, byRisk.LOW, byRisk.MEDIUM, byRisk.HIGH);
  const maxTeam = Math.max(1, ...byTeam.map(([, n]) => n));

  // PERF-15: the all-teams, all-time table renders at most DEFAULT_WINDOW_SIZE
  // rows at a time — every prior request, across every team, forever, with no
  // cap otherwise. Resets to the default whenever team/status change, same
  // rule as MyRequests/ApprovalsQueue. `exportCsv` above is deliberately
  // unaffected — it writes ALL of `rows`, not just the windowed slice, since a
  // CSV export with a silent row cap would be a much worse surprise than a
  // "Show more" button.
  const [visibleCount, setVisibleCount] = useState(DEFAULT_WINDOW_SIZE);
  useEffect(() => setVisibleCount(DEFAULT_WINDOW_SIZE), [team, status]);
  const { visible: visibleRows, hiddenCount } = windowSlice(rows, visibleCount);

  const exportCsv = (): void => {
    const cell = (v: unknown): string => {
      const s = String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = ['Requester', 'Team', 'Change', 'Target', 'Risk', 'Status', 'Approvals', 'Created', 'PR'];
    const lines = rows.map((r) => {
      const op = getOperation(r.operationId, manifests);
      return [
        userName(r.requester),
        teamName(r.teamId),
        op?.title ?? r.operationId,
        r.targetAddress,
        r.risk,
        r.status,
        `${r.approvals?.length ?? 0}/${r.approvalsRequired ?? 1}`,
        new Date(r.createdAt).toISOString(),
        r.prNumber ? `#${r.prNumber}` : '',
      ];
    });
    const csv = [header, ...lines].map((row) => row.map(cell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'ccp-requests.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="dash">
      <header className="dash__head">
        <div className="dash__head-main">
          <p className="page-eyebrow">Audit and activity</p>
          <h1 className="dash__title">Dashboard</h1>
          <p className="dash__subtitle">
            Every change request across all teams — who requested, who approved, what applied.
          </p>
        </div>
        {/* Data-authority header meta (Ledger contract #4) — only the totals
            this page already has on hand (the same summary the stat strip
            below reads). */}
        {!loading && (
          <div className="dash__headmeta">
            <b>{summary.total}</b> total requests
            <br />
            <b>{summary.awaiting}</b> awaiting review
          </div>
        )}
      </header>

      <DriftPanel />

      {loadError !== null ? (
        <LoadError
          message={loadError}
          what="the dashboard"
          onRetry={() => setReloadToken((n) => n + 1)}
        />
      ) : loading ? (
        <p className="dash__empty">Loading…</p>
      ) : (
        <>
          <div className="dash__stats" role="group" aria-label="Summary">
            <Tile label="Total requests" value={summary.total} tone="neutral" />
            <Tile label="Awaiting review" value={summary.awaiting} tone="wait" />
            <Tile label="Applied" value={summary.applied} tone="done" />
            <Tile label="Rejected" value={summary.rejected} tone="fail" />
          </div>

          <div className="dash__viz">
            <div className="dash-chart">
              <h2 className="dash-chart__title">By risk</h2>
              {(['LOW', 'MEDIUM', 'HIGH'] as const).map((level) => (
                <div className="dash-chart__row" key={level}>
                  <span className="dash-chart__label">{level[0] + level.slice(1).toLowerCase()}</span>
                  <span className="dash-chart__track">
                    <span
                      className={`dash-chart__bar dash-chart__bar--risk-${level.toLowerCase()}`}
                      style={{ width: `${(byRisk[level] / maxRisk) * 100}%` }}
                    />
                  </span>
                  <span className="dash-chart__num">{byRisk[level]}</span>
                </div>
              ))}
            </div>

            <div className="dash-chart">
              <h2 className="dash-chart__title">By team</h2>
              {byTeam.length === 0 ? (
                <p className="dash-chart__empty">No requests in view.</p>
              ) : (
                byTeam.map(([name, n]) => (
                  <div className="dash-chart__row" key={name}>
                    <span className="dash-chart__label" title={name}>
                      {name}
                    </span>
                    <span className="dash-chart__track">
                      <span
                        className="dash-chart__bar dash-chart__bar--team"
                        style={{ width: `${(n / maxTeam) * 100}%` }}
                      />
                    </span>
                    <span className="dash-chart__num">{n}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="dash__controls">
            <label className="dash__filter">
              <span className="dash__filter-label">Team</span>
              <select
                className="dash__select"
                value={team}
                onChange={(e) => setTeam(e.target.value)}
              >
                <option value="all">All teams</option>
                {teams.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="dash__filter">
              <span className="dash__filter-label">Status</span>
              <select
                className="dash__select"
                value={status}
                onChange={(e) => setStatus(e.target.value as StatusFilter)}
              >
                <option value="all">All statuses</option>
                {statusOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <span className="dash__count">
              {rows.length} of {requests.length}
            </span>
            <button
              type="button"
              className="dash__export"
              onClick={exportCsv}
              disabled={rows.length === 0}
            >
              Export CSV
            </button>
          </div>

          <div className="dash__table-wrap">
            <table className="dash-table">
              <thead>
                <tr>
                  <th>Requester</th>
                  <th>Team</th>
                  <th>Change</th>
                  <th>Target</th>
                  <th>Risk</th>
                  <th>Status</th>
                  <th>Approvals</th>
                  <th>Created</th>
                  <th>PR</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="dash-table__empty">
                      No requests match these filters.
                    </td>
                  </tr>
                ) : (
                  visibleRows.map((r) => {
                    const op = getOperation(r.operationId, manifests);
                    const meta = getServiceMeta(r.service);
                    const title = op?.title ?? r.operationId;
                    return (
                      <tr key={r.id}>
                        <td>{userName(r.requester)}</td>
                        <td className="dash-table__muted">{teamName(r.teamId)}</td>
                        <td>
                          <Link className="dash-table__link" to={`/requests/${r.id}`}>
                            {title}
                          </Link>
                          <span className="dash-table__svc">{meta.displayName}</span>
                        </td>
                        <td className="dash-table__mono">{r.targetAddress}</td>
                        <td>
                          <RiskBadge risk={r.risk} />
                        </td>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>
                          <ApprovalsCell request={r} />
                        </td>
                        <td className="dash-table__num">
                          {formatProjectDate(r.createdAt)}
                        </td>
                        <td className="dash-table__num">
                          {r.prNumber ? (
                            <a
                              className="dash-table__pr"
                              href={r.prUrl}
                              target="_blank"
                              rel="noreferrer"
                            >
                              #{r.prNumber}
                            </a>
                          ) : (
                            <span className="dash-table__muted">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
                {hiddenCount > 0 && (
                  <tr>
                    <td colSpan={9} className="dash-table__more">
                      <button
                        type="button"
                        className="dash-table__more-btn"
                        onClick={() => setVisibleCount((n) => n + DEFAULT_WINDOW_SIZE)}
                      >
                        Show {Math.min(hiddenCount, DEFAULT_WINDOW_SIZE)} more ({hiddenCount} remaining)
                      </button>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
