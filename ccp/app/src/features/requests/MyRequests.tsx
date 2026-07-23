import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ChangeRequest, Inventory, RequestStatus, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { getCurrentUser } from '@/lib/session';
import { getOperation } from '@/lib/interpreter';
import { getServiceMeta } from '@/lib/serviceMeta';
import { formatProjectDate, formatProjectTime } from '@/lib/datetime';
import { beyondCatalogTitle, isBeyondCatalogRequest } from '@/lib/beyondCatalog';
import { provisionRequestTitle } from '@/lib/providerCatalog';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { ApprovalLadder } from '@/components/ui/ApprovalLadder';
import { SearchBar } from '@/components/SearchBar';
import './requests.css';

/** Every RequestStatus value, for the status filter's option list (Task 3) —
 * a shared view must stay meaningful even for a status nothing currently has.
 * APPROVED_COOLING/CANCELLED are api-mode only — the mock never
 * produces them, so they simply never match anything under mock-mode, same
 * as any other status nothing currently has. */
const ALL_STATUSES: RequestStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'GENERATING',
  'CHECKS_RUNNING',
  'PLAN_READY',
  'AWAITING_CODE_REVIEW',
  'CHANGES_REQUESTED',
  'CODE_APPROVED',
  'MERGED',
  'AWAITING_DEPLOY_APPROVAL',
  'APPLYING',
  'APPLIED',
  'NOOP',
  'APPLY_FAILED',
  'DIGEST_MISMATCH',
  'REJECTED',
  'NEEDS_ENGINEER',
  'WITHDRAWN',
  'APPROVED_COOLING',
  'CANCELLED',
];
const STATUS_SET = new Set<string>(ALL_STATUSES);

/** "AWAITING_CODE_REVIEW" → "Awaiting code review" — readable option text. */
function humanizeStatus(status: string): string {
  const lower = status.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export interface RequestFilters {
  status: string;
  q: string;
}

/** Pure URL → filter-state coercion (Task 3). Invalid/unknown values fall back
 * to the documented defaults so a bad or hand-edited URL degrades to "show
 * everything" rather than an empty or broken view. */
export function parseFilters(sp: URLSearchParams): RequestFilters {
  const rawStatus = sp.get('status') ?? 'all';
  const status = rawStatus === 'all' || STATUS_SET.has(rawStatus) ? rawStatus : 'all';
  return { status, q: sp.get('q') ?? '' };
}

/** Merge a partial filter change into the current URLSearchParams, dropping
 * keys back to their default so a cleared filter leaves no `?status=all` cruft. */
function withFilters(current: URLSearchParams, patch: Partial<RequestFilters>): URLSearchParams {
  const merged = { ...parseFilters(current), ...patch };
  const next = new URLSearchParams(current);
  if (merged.status === 'all') next.delete('status');
  else next.set('status', merged.status);
  if (merged.q === '') next.delete('q');
  else next.set('q', merged.q);
  return next;
}

/** Lifecycle lane a request sorts into on this screen. */
type Lane = 'active' | 'review' | 'done';

const REVIEW_STATUSES = new Set<RequestStatus>([
  'AWAITING_CODE_REVIEW',
  'CHANGES_REQUESTED',
  'AWAITING_DEPLOY_APPROVAL',
  // Fully approved but not yet live (cooling-off) — the
  // same "quorum's done, something else is still outstanding" bucket
  // AWAITING_DEPLOY_APPROVAL already sits in, not a fresh "review" lane.
  'APPROVED_COOLING',
]);

const DONE_STATUSES = new Set<RequestStatus>([
  'APPLIED',
  'NOOP',
  'REJECTED',
  'WITHDRAWN',
  'APPLY_FAILED',
  'DIGEST_MISMATCH',
  // Terminal, self/senior-initiated stop during the cooling window —
  // same bucket as REJECTED/WITHDRAWN.
  'CANCELLED',
]);

function laneFor(status: RequestStatus): Lane {
  if (DONE_STATUSES.has(status)) return 'done';
  if (REVIEW_STATUSES.has(status)) return 'review';
  return 'active';
}

const LANE_TITLE: Record<Lane, string> = {
  active: 'Active',
  review: 'Awaiting review',
  done: 'Done',
};

const LANE_ORDER: Lane[] = ['active', 'review', 'done'];

function shortTime(iso: string): string {
  return formatProjectTime(iso);
}

function RequestRow({
  request,
  manifests,
  targetName,
}: {
  request: ChangeRequest;
  manifests: ServiceManifest[];
  targetName: string;
}): JSX.Element {
  const op = getOperation(request.operationId, manifests);
  const meta = getServiceMeta(request.service);
  // getOperation() is undefined for a beyond-catalog request by design (Task
  // 1) — there is no manifest op behind it, so fall back to a readable title
  // derived from the stored fields instead of the raw operationId slug.
  const title = isBeyondCatalogRequest(request)
    ? beyondCatalogTitle(request)
    : (op?.title ?? provisionRequestTitle(request));

  const awaiting = laneFor(request.status) === 'review';
  const required = request.approvalsRequired ?? 0;
  const showCount = awaiting && required > 0;
  const scheduled = request.schedule?.kind === 'window' ? request.schedule : undefined;

  return (
    <div className="rq-row">
      <span className="rq-row__mono" aria-hidden="true">
        {meta.monogram}
      </span>

      <div className="rq-row__body">
        <Link className="rq-row__link" to={`/requests/${request.id}`}>
          {title}
        </Link>
        <div className="rq-row__meta">
          <span>{meta.displayName}</span>
          <span className="rq-row__sep" aria-hidden="true">
            ·
          </span>
          <span className="rq-row__addr">{targetName}</span>
        </div>
      </div>

      <div className="rq-row__side">
        <div className="rq-row__tags">
          <MacdTag macd={request.macd} />
          <RiskBadge risk={request.risk} />
          <StatusBadge status={request.status} />
          {showCount ? (
            // S-08/F-03: size='row' collapses to the same compact N/M pill
            // this row always showed — now the shared component, so a
            // richer tooltip (who's next, when the api provides it) comes
            // for free. `viewerCanSign` is inert at this size (no button
            // here to gate) — every row is the viewer's OWN request, so it
            // is always false anyway (self-approval is never permitted).
            <ApprovalLadder
              required={required}
              approvals={request.approvals ?? []}
              nextStep={request.nextApprovalStep}
              viewerCanSign={false}
              size="row"
            />
          ) : null}
          {scheduled ? (
            <span className="rq-row__sched" title={`Scheduled for ${shortTime(scheduled.at)}`}>
              Scheduled
            </span>
          ) : null}
        </div>

        <div className="rq-row__end">
          <span className="rq-row__when">{formatProjectDate(request.createdAt)}</span>
          {request.prUrl ? (
            // The loop closer: once an engineer's PR is linked (or the
            // Stage-2 pipeline opened one), the row answers "did anything
            // happen?" with the PR itself.
            <a className="rq-row__pr" href={request.prUrl} target="_blank" rel="noreferrer">
              {request.prNumber ? `#${request.prNumber} · ` : ''}Track the engineering PR →
            </a>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function MyRequests(): JSX.Element {
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [inventory, setInventory] = useState<Inventory | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = useActiveProjectId();

  useEffect(() => {
    let active = true;
    void Promise.all([
      api.listRequests(getCurrentUser().id),
      api.listManifests(),
      api.getInventory(),
    ]).then(([r, m, inv]) => {
      if (!active) return;
      setRequests(r);
      setManifests(m);
      setInventory(inv);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [projectId]);

  /** address → human name, so rows read a real host rather than a Terraform address. */
  const nameByAddress = useMemo(() => {
    const map = new Map<string, string>();
    for (const res of inventory?.resources ?? []) {
      if (res.name) map.set(res.address, res.name);
    }
    return map;
  }, [inventory]);

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const setStatus = (status: string): void =>
    setSearchParams(withFilters(searchParams, { status }), { replace: true });
  const setQuery = (q: string): void =>
    setSearchParams(withFilters(searchParams, { q }), { replace: true });

  const filteredRequests = useMemo(() => {
    const needle = filters.q.trim().toLowerCase();
    return requests.filter((r) => {
      if (filters.status !== 'all' && r.status !== filters.status) return false;
      if (!needle) return true;
      const op = getOperation(r.operationId, manifests);
      const title = isBeyondCatalogRequest(r)
        ? beyondCatalogTitle(r)
        : (op?.title ?? provisionRequestTitle(r));
      const targetName = nameByAddress.get(r.targetAddress) ?? r.targetAddress;
      const meta = getServiceMeta(r.service);
      return (
        title.toLowerCase().includes(needle) ||
        meta.displayName.toLowerCase().includes(needle) ||
        targetName.toLowerCase().includes(needle) ||
        r.targetAddress.toLowerCase().includes(needle) ||
        r.justification.toLowerCase().includes(needle)
      );
    });
  }, [requests, manifests, nameByAddress, filters]);

  const lanes = useMemo(() => {
    const grouped: Record<Lane, ChangeRequest[]> = { active: [], review: [], done: [] };
    const sorted = [...filteredRequests].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    for (const r of sorted) grouped[laneFor(r.status)].push(r);
    return grouped;
  }, [filteredRequests]);

  const isFiltered = filters.status !== 'all' || filters.q.trim() !== '';

  return (
    <div className="reqs">
      <header className="reqs__head">
        <div className="reqs__head-main">
          <p className="page-eyebrow">Your activity</p>
          <h1 className="reqs__title">My requests</h1>
        </div>
        <Link to="/" className="reqs__new">
          + New request
        </Link>
      </header>

      {requests.length > 0 && (
        <div className="reqs__filters">
          <SearchBar
            value={filters.q}
            onChange={setQuery}
            placeholder="Search your requests"
            ariaLabel="Search your requests"
          />
          <select
            className="reqs__status-select"
            aria-label="Filter by status"
            value={filters.status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="all">All statuses</option>
            {ALL_STATUSES.map((s) => (
              <option key={s} value={s}>
                {humanizeStatus(s)}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading ? (
        <p className="reqs__empty">Loading…</p>
      ) : requests.length === 0 ? (
        <p className="reqs__empty">
          No requests yet. <Link to="/">Request a change</Link> to get started.
        </p>
      ) : filteredRequests.length === 0 ? (
        <p className="reqs__empty">
          No requests match these filters.
          {isFiltered && (
            <>
              {' '}
              <button
                type="button"
                className="reqs__clear"
                onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
              >
                Clear filters
              </button>
            </>
          )}
        </p>
      ) : (
        <div className="reqs__lanes">
          {LANE_ORDER.map((lane) => {
            const items = lanes[lane];
            if (items.length === 0) return null;
            return (
              <section key={lane} className="reqs__lane">
                <h2 className="reqs__lane-title">
                  {LANE_TITLE[lane]}
                  <span className="reqs__lane-count">{items.length}</span>
                </h2>
                <div className="reqs__list">
                  {items.map((r) => (
                    <RequestRow
                      key={r.id}
                      request={r}
                      manifests={manifests}
                      targetName={nameByAddress.get(r.targetAddress) ?? r.targetAddress}
                    />
                  ))}
                </div>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
