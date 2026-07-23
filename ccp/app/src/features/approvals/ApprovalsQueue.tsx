import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react';
import type { JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { ChangeRequest, Inventory, RequestStatus, ServiceManifest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { resolveName } from '@/lib/accounts';
import { getCurrentUser, useCurrentUser } from '@/lib/session';
import { canApprove } from '@/lib/permissions';
import { approveAnnouncement, canSignApprovalStep } from '@/lib/approvalLadder';
import { getOperation } from '@/lib/interpreter';
import { getServiceMeta } from '@/lib/serviceMeta';
import { projectCalendarAgeDays } from '@/lib/datetime';
import { generateDiff, plainSummary } from '@/lib/diff';
import {
  BEYOND_CATALOG_NOTE,
  beyondCatalogTitle,
  describeBeyondCatalogRequest,
} from '@/lib/beyondCatalog';
import {
  PROVISION_NOTE,
  describeProvisionRequest,
  provisionRequestTitle,
} from '@/lib/providerCatalog';
import { changeSetRequirement, exposureForTier, isChangeSet, itemsOf } from '@/lib/changeSet';
import { DiffView } from '@/components/DiffView';
import { FullBlockDiff } from '@/components/FullBlockDiff';
import { useFullBlockDiff } from '@/components/useFullBlockDiff';
import { ChangeSetView } from '@/components/ChangeSetView';
import { hasPlanContent, PlanSummaryBlock } from '@/features/requests/PlanSummaryPanel';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { AccessBadge } from '@/components/ui/AccessBadge';
import { Button } from '@/components/ui/Button';
import { ApprovalLadder } from '@/components/ui/ApprovalLadder';
import { SearchBar } from '@/components/SearchBar';
import { describeApproveError } from './approveError';
import './approvals.css';

function userName(id: string): string {
  return resolveName(id);
}

/** Unchanged rule from the `window.prompt` validation. */
const MIN_REJECT_REASON = 10;

/** Pure so the ≥10-char rule is directly unit-testable (this app has no
 * jsdom — src/test/setup.ts) without mounting RejectForm. */
export function isRejectReasonValid(reason: string): boolean {
  return reason.trim().length >= MIN_REJECT_REASON;
}

/**
 * The queue-row AGE chip label (loop-closure gate): how
 * long a request has waited, on the estate's calendar (projectCalendarAgeDays,
 * the same source every timestamp uses). Pure and exported so it is testable
 * without mounting the card. Null when the timestamp is missing/invalid — the
 * chip is then simply not rendered, never a bogus "0 days".
 */
export function queueAgeLabel(iso: string | undefined, now: Date = new Date()): string | null {
  const days = projectCalendarAgeDays(iso, now);
  if (days === null) return null;
  if (days === 0) return 'today';
  return days === 1 ? '1 day old' : `${days} days old`;
}

/** DOM id of the "Reject" trigger button for a given request — used to
 * return focus there when the inline reason form is cancelled (the
 * form/textarea that held focus is about to unmount, and without this
 * the browser would drop focus to `<body>`). `Button` (components/ui/Button.tsx)
 * doesn't forward refs, so an id + `document.getElementById` is the
 * lowest-footprint way to do this without touching a file outside this
 * task's fence. */
function rejectTriggerId(requestId: string): string {
  return `apv-reject-trigger-${requestId}`;
}

/** Same fixed option set as MyRequests (Task 3) — kept local per this file's
 * scope rather than shared, matching the plan's per-screen file list.
 * Includes APPROVED_COOLING/CANCELLED for vocabulary parity with MyRequests
 * even though `scope=pending` (this screen's data source) structurally never
 * returns either — routes/requests.ts filters to OPEN_STATUSES
 * (AWAITING_CODE_REVIEW/NEEDS_ENGINEER) only, same as every other status
 * already listed here that this queue can never actually show (APPLIED,
 * REJECTED, WITHDRAWN, …). */
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

function humanizeStatus(status: string): string {
  const lower = status.toLowerCase().replace(/_/g, ' ');
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export interface RequestFilters {
  status: string;
  q: string;
}

/** Pure URL → filter-state coercion (Task 3) — identical contract to
 * MyRequests' parseFilters: invalid/unknown values fall back to 'all' / ''. */
export function parseFilters(sp: URLSearchParams): RequestFilters {
  const rawStatus = sp.get('status') ?? 'all';
  const status = rawStatus === 'all' || STATUS_SET.has(rawStatus) ? rawStatus : 'all';
  return { status, q: sp.get('q') ?? '' };
}

function withFilters(current: URLSearchParams, patch: Partial<RequestFilters>): URLSearchParams {
  const merged = { ...parseFilters(current), ...patch };
  const next = new URLSearchParams(current);
  if (merged.status === 'all') next.delete('status');
  else next.set('status', merged.status);
  if (merged.q === '') next.delete('q');
  else next.set('q', merged.q);
  return next;
}

/**
 * Patch (or drop) one request from a mutation's returned result — pure, so
 * this is unit-testable without mounting the queue. Replaces
 * `load()`'s post-mutation triple refetch: the mock's
 * approveRequest/rejectRequest both return the fully mutated
 * `ChangeRequest` (approvals, the tighten-only re-gated `approvalsRequired`
 * and the post-mutation `status`), so no follow-up read is
 * needed to know whether the request should stay in this "pending review"
 * queue or drop out of it. A request stays only while still
 * AWAITING_CODE_REVIEW — approve pushing it past quorum (APPLIED /
 * AWAITING_DEPLOY_APPROVAL) or a reject (always REJECTED) both remove it,
 * matching what a fresh `listPendingApprovals()` would have returned anyway.
 */
export function applyMutatedRequestToList(
  requests: ChangeRequest[],
  updated: ChangeRequest,
): ChangeRequest[] {
  return updated.status === 'AWAITING_CODE_REVIEW'
    ? requests.map((r) => (r.id === updated.id ? updated : r))
    : requests.filter((r) => r.id !== updated.id);
}

/**
 * Inline rejection-reason form — replaces the
 * `window.prompt`, which is blocking, unstylable, and screen-reader-hostile.
 * Mounted in place of the footer's action buttons while this card is the
 * one being rejected; autofocuses its textarea and closes on Escape, same
 * "cancel = do nothing" contract `window.prompt` had. Kept as its own
 * component (not inline JSX) so its draft `reason`/`touched` state resets
 * for free on every mount — one card's abandoned draft never leaks into
 * another's.
 */
function RejectForm({
  requestId,
  busy,
  onCancel,
  onConfirm,
}: {
  requestId: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (id: string, reason: string) => void;
}): JSX.Element {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const tooShort = !isRejectReasonValid(reason);
  const showError = touched && tooShort;
  const errorId = `reject-reason-${requestId}-error`;

  const submit = (): void => {
    if (tooShort) {
      setTouched(true);
      return;
    }
    onConfirm(requestId, reason.trim());
  };

  return (
    <form
      className="apv-reject"
      aria-label="Reject this request"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="apv-reject__label" htmlFor={`reject-reason-${requestId}`}>
        Reason for rejecting this request{' '}
        <span className="apv-reject__hint">(shown on the timeline)</span>
      </label>
      <textarea
        ref={textareaRef}
        id={`reject-reason-${requestId}`}
        className="apv-reject__textarea"
        rows={2}
        value={reason}
        disabled={busy}
        aria-invalid={showError}
        aria-describedby={showError ? errorId : undefined}
        onChange={(e) => setReason(e.target.value)}
        onBlur={() => setTouched(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onCancel();
          }
        }}
      />
      {showError && (
        <p id={errorId} className="apv-reject__error" role="alert">
          A rejection reason of at least 10 characters is required.
        </p>
      )}
      <div className="apv-reject__actions">
        <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy}>
          Confirm reject
        </Button>
      </div>
    </form>
  );
}

export function ReviewCard({
  request,
  manifests,
  inventory,
  onApprove,
  rejecting,
  onStartReject,
  onCancelReject,
  onConfirmReject,
  busy,
}: {
  request: ChangeRequest;
  manifests: ServiceManifest[];
  inventory: Inventory;
  onApprove: (id: string) => void;
  rejecting: boolean;
  onStartReject: (id: string) => void;
  onCancelReject: (id: string) => void;
  onConfirmReject: (id: string, reason: string) => void;
  busy: boolean;
}): JSX.Element {
  // Pilot: React Compiler, annotation mode. ReviewCard is the app's
  // headline zero-`React.memo` hot path — any ApprovalsQueue state
  // change (busyId, error, filters) re-renders every card and its diff
  // subtree today. Opted in first because it has no render-phase side
  // effects (getOperation/getServiceMeta/plainSummary/generateDiff are pure;
  // useFullBlockDiff and useCurrentUser are ordinary effect-backed hooks) —
  // safe for the compiler to memoize wholesale.
  'use memo';
  const op = getOperation(request.operationId, manifests);
  const meta = getServiceMeta(request.service);
  // getOperation() is undefined for a beyond-catalog request by design (Task
  // 1) — there is no manifest op, so this card must tolerate it: a readable
  // title derived from the stored fields, and a dedicated panel below instead
  // of a generated summary/diff.
  const beyondCatalog = describeBeyondCatalogRequest(request);
  // …and undefined for a schema-generated provision request the same way —
  // its stored params render as a parameter sheet below.
  const provision = describeProvisionRequest(request);
  const title = beyondCatalog
    ? beyondCatalogTitle(request)
    : (op?.title ?? provisionRequestTitle(request));
  const targetName =
    inventory.resources.find((r) => r.address === request.targetAddress)?.name ??
    request.targetAddress;

  // Unified with RequestDetail/MyRequests' own default (0037, ApprovalLadder
  // adoption): an undefined `approvalsRequired` is now owned by the ladder's
  // own graceful "awaiting requirement" state (lib/approvalLadder.ts), not
  // by defaulting up to 1 here — this queue's rows are always
  // AWAITING_CODE_REVIEW, which the api always stamps with a real computed
  // count, so the 0-of-0 branch is defensive rather than reachable today.
  const required = request.approvalsRequired ?? 0;
  const summary = op ? plainSummary(op, request.params, inventory) : request.justification;
  // Render the diff the requester reviewed (pinned at submit), not one
  // regenerated from mutable inventory. Fall back for legacy/seed rows.
  const diff = request.pinnedDiff ?? (op ? generateDiff(op, request.params, inventory) : '');
  // The full enclosing block, so the approver sees exactly what the requester saw.
  const blockDiff = useFullBlockDiff(op, request.params, request.targetAddress);

  // Phase B: is this a multi-operation change set? A set's top-level title/target/macd/risk are
  // only items[0]'s — the card must disclose the WHOLE set and the strictest-combined bar, so a
  // reviewer can never approve N operations while shown one. Single-op cards are unchanged.
  const items = itemsOf(request);
  const isSet = isChangeSet(request);
  const combined = isSet ? changeSetRequirement(items) : undefined;

  // Separation of duties: never offer approve on your own request or a second
  // time. 0025 RX-4: live — a role/SoD-relevant change to your own account
  // elsewhere updates this without a navigation. 0037: additionally, only offer
  // Approve to a viewer whose role can sign the NEXT ladder step (the server
  // re-enforces this; nextApprovalStep is absent in mock-mode, where the base
  // canApprove rule stands alone).
  const currentUser = useCurrentUser();
  const nextStep = request.nextApprovalStep;
  const mayApprove =
    canApprove(currentUser, request) &&
    (nextStep === undefined
      ? true
      : nextStep !== null && canSignApprovalStep(nextStep, currentUser.role));
  const ageLabel = queueAgeLabel(request.createdAt);

  return (
    <article className="apv-card">
      <header className="apv-card__head">
        <div className="apv-card__mono" aria-hidden="true">
          {meta.monogram}
        </div>
        <div className="apv-card__heading">
          <Link className="apv-card__title" to={`/requests/${request.id}`}>
            {isSet ? `Change set — ${items.length} operations` : title}
          </Link>
          {/* Mono meta row (Ledger contract #4): service · target · requester ·
              age — one quiet data-authority line, folding in what used to be a
              separate "Requested by" line below the summary and an age chip
              beside the risk/macd tags. */}
          <div className="apv-card__meta">
            {isSet ? (
              <span>{items.length} operations reviewed and applied as one change</span>
            ) : (
              <>
                <span>{meta.displayName}</span>
                <span className="apv-card__sep" aria-hidden="true">
                  ·
                </span>
                <span>{targetName}</span>
              </>
            )}
            <span className="apv-card__sep" aria-hidden="true">
              ·
            </span>
            <span>Requested by {userName(request.requester)}</span>
            {ageLabel && (
              <>
                <span className="apv-card__sep" aria-hidden="true">
                  ·
                </span>
                <span title="Time waiting in the queue">{ageLabel}</span>
              </>
            )}
          </div>
          {/* The raw Terraform address, its own quiet mono line — same
              dual-display idiom as console.css's .rr__name + .rr__addr. */}
          <div className="apv-card__target apv-card__addr">
            {isSet ? `${items.length} operations` : request.targetAddress}
          </div>
        </div>
        <div className="apv-card__tags">
          {isSet && combined ? (
            // A set's macd/risk are only items[0]'s — show the count + the strictest review
            // tier across all items instead (the approvals bar below is already combined).
            <>
              <span className="apv-card__setcount" title="Operations in this change set">
                {items.length} ops
              </span>
              <AccessBadge exposure={exposureForTier(combined.tier)} />
            </>
          ) : (
            <>
              <MacdTag macd={request.macd} />
              <RiskBadge risk={request.risk} />
            </>
          )}
        </div>
      </header>

      {isSet ? (
        // The WHOLE change set — combined requirement + every operation, target and diff — so
        // the reviewer sees all N operations, not just the primary one.
        <ChangeSetView items={items} manifests={manifests} inventory={inventory} />
      ) : beyondCatalog ? (
        // No FullBlockDiff, no param diff — there is no Terraform to show yet.
        // The v2 structured tail renders as a SPEC SHEET: workload,
        // sizing, connectivity, classification, needed-by — so L2 reviews a
        // specification, not one prose paragraph.
        <div className="apv-card__beyond">
          <dl className="apv-card__beyond-facts">
            <dt>Kind</dt>
            <dd>{beyondCatalog.kindLabel}</dd>
            <dt>Service</dt>
            <dd className="apv-card__addr">{beyondCatalog.service}</dd>
            {beyondCatalog.resourceType && (
              <>
                <dt>Resource type</dt>
                <dd className="apv-card__addr">{beyondCatalog.resourceType}</dd>
              </>
            )}
            {beyondCatalog.workload && (
              <>
                <dt>Workload</dt>
                <dd>{beyondCatalog.workload}</dd>
              </>
            )}
            {beyondCatalog.sizing && (
              <>
                <dt>Sizing</dt>
                <dd>{beyondCatalog.sizing}</dd>
              </>
            )}
            {beyondCatalog.connectivity && (
              <>
                <dt>Connectivity</dt>
                <dd>{beyondCatalog.connectivity}</dd>
              </>
            )}
            {beyondCatalog.dataClassification && (
              <>
                <dt>Data classification</dt>
                <dd>{beyondCatalog.dataClassification}</dd>
              </>
            )}
            {beyondCatalog.neededBy && (
              <>
                <dt>Needed by</dt>
                <dd>{beyondCatalog.neededBy}</dd>
              </>
            )}
          </dl>
          <p className="apv-card__summary">{beyondCatalog.summary}</p>
          <p className="apv-card__note">{BEYOND_CATALOG_NOTE}</p>
        </div>
      ) : provision ? (
        // A schema-generated provision: the approver reviews the FULL
        // parameter sheet the requester filled in — every value, not a summary.
        <div className="apv-card__beyond">
          <dl className="apv-card__beyond-facts">
            <dt>Resource type</dt>
            <dd className="apv-card__addr">{provision.resourceType}</dd>
            {provision.rows.map((row) => (
              <div key={row.label} className="apv-card__beyond-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          {provision.rows.length === 0 && (
            <p className="apv-card__summary">No parameters were filled in — defaults throughout.</p>
          )}
          <p className="apv-card__note">{PROVISION_NOTE}</p>
        </div>
      ) : (
        <p className="apv-card__summary">{summary}</p>
      )}

      {!isSet && (blockDiff || diff) && (
        // Open by default: an approver should see exactly what they are approving
        // before they can act — never approve a change sight-unseen. (A set's per-item
        // diffs are shown, open, inside ChangeSetView above.)
        <details className="apv-diff" open>
          <summary className="apv-diff__summary">
            {blockDiff ? 'The block being changed' : 'Terraform diff'}
          </summary>
          {blockDiff ? <FullBlockDiff diff={blockDiff} /> : <DiffView diff={diff} />}
        </details>
      )}

      {/* (visibility): the recorded `terraform plan` summary —
          the L2 reviews what the plan PROVES this does (incl. the replace
          consequence panel), or an honest "no plan yet" note. Never a fake. */}
      {!beyondCatalog && hasPlanContent(request.status, request.planSummary) && (
        <div className="apv-card__plan">
          <PlanSummaryBlock status={request.status} planSummary={request.planSummary} />
        </div>
      )}

      <footer className="apv-card__foot">
        {rejecting ? (
          <RejectForm
            requestId={request.id}
            busy={busy}
            onCancel={() => onCancelReject(request.id)}
            onConfirm={onConfirmReject}
          />
        ) : (
          <>
            {/* Footer LEFT slot (kept exactly where it was — Approve/Reject
                stay on the right for muscle memory). F-03/F-04/S-08: the old
                12px mono progress string is now the shared stepper — WHO
                signed, WHAT KIND of signer is next, WHEN it applies
                (formatProjectTime inside the component, never slice()), and
                whether THIS viewer can act. */}
            <div className="apv-card__progress" data-label="Progress">
              <ApprovalLadder
                required={required}
                approvals={request.approvals ?? []}
                nextStep={nextStep}
                schedule={request.schedule}
                viewerCanSign={mayApprove}
                viewerIsOwnRequest={request.requester === currentUser.id}
                size="card"
              />
            </div>
            <div className="apv-card__actions">
              <Button
                id={rejectTriggerId(request.id)}
                variant="ghost"
                disabled={busy}
                onClick={() => onStartReject(request.id)}
              >
                Reject
              </Button>
              <Button
                variant="primary"
                disabled={busy || !mayApprove}
                onClick={() => onApprove(request.id)}
              >
                Approve
              </Button>
            </div>
          </>
        )}
      </footer>
    </article>
  );
}

export function ApprovalsQueue(): JSX.Element {
  const [requests, setRequests] = useState<ChangeRequest[]>([]);
  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [inventory, setInventory] = useState<Inventory | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // S-09 / Lane B: approve silently dropped the card with no async
  // confirmation for a screen-reader user. A polite live region announces
  // the outcome using the MUTATION's OWN returned counts (never re-derived
  // from stale pre-mutation state), so "remaining" is always the
  // post-approve truth.
  const [announcement, setAnnouncement] = useState('');
  const [searchParams, setSearchParams] = useSearchParams();
  // Wraps applying a mutation's result to `requests` — the (unmemoized)
  // card list re-render this triggers is low-priority: the queue
  // stays scrollable/filterable while it commits. `busyId` is
  // deliberately set/cleared OUTSIDE this transition — it is local, urgent
  // state (the acting card's own busy affordance must show immediately).
  const [isPending, startTransition] = useTransition();

  // Keyed on the active project: a project switch mints a new `load`, and the
  // effect below re-runs it against the newly scoped catalog/inventory/queue.
  const projectId = useActiveProjectId();
  const load = useCallback(async () => {
    const [pending, m, inv] = await Promise.all([
      api.listPendingApprovals(getCurrentUser()),
      api.listManifests(),
      api.getInventory(),
    ]);
    setRequests(pending);
    setManifests(m);
    setInventory(inv);
    setLoading(false);
    // projectId is the refetch key, not an input to the fetch itself —
    // api.ts reads the ambient project scope at call time (same shape as
    // ServiceConsole's `settings` memo dependency).
  }, [projectId]);

  useEffect(() => {
    let active = true;
    void load().then(() => {
      if (!active) return;
    });
    return () => {
      active = false;
    };
  }, [load]);

  // See applyMutatedRequestToList's doc comment for why a patch replaces the
  // old triple refetch, and why manifests/inventory are never re-fetched
  // here (neither mutation can change the catalog or
  // the estate, so the ONE targeted refetch the plan allowed for isn't
  // needed either).
  const applyMutatedRequest = useCallback((updated: ChangeRequest): void => {
    setRequests((prev) => applyMutatedRequestToList(prev, updated));
  }, []);

  const approve = useCallback(
    async (id: string) => {
      setBusyId(id);
      setError(null);
      const result = await api.approveRequest(id);
      startTransition(() => {
        if (result.ok) {
          applyMutatedRequest(result.request);
          setAnnouncement(
            approveAnnouncement(
              result.request.approvals?.length ?? 0,
              result.request.approvalsRequired ?? 0,
            ),
          );
        } else {
          setError(describeApproveError(result));
        }
      });
      setBusyId(null);
    },
    [applyMutatedRequest],
  );

  // Opens the inline reason form in place of this card's action buttons —
  // no request/state change yet (replaces window.prompt).
  const startReject = useCallback((id: string) => {
    setError(null);
    setRejectingId(id);
  }, []);

  // "Cancel" or Escape inside the form — same "do nothing" contract
  // window.prompt's cancel button had. Returns focus to the Reject trigger,
  // since the textarea that held it is about to unmount.
  const cancelReject = useCallback((id: string) => {
    setRejectingId(null);
    requestAnimationFrame(() => document.getElementById(rejectTriggerId(id))?.focus());
  }, []);

  const confirmReject = useCallback(
    async (id: string, reason: string) => {
      setBusyId(id);
      setError(null);
      const result = await api.rejectRequest(id, reason);
      startTransition(() => {
        if (result.ok) applyMutatedRequest(result.request);
        else setError(result.reason);
        setRejectingId(null);
      });
      setBusyId(null);
    },
    [applyMutatedRequest],
  );

  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const setStatus = (status: string): void =>
    setSearchParams(withFilters(searchParams, { status }), { replace: true });
  const setQuery = (q: string): void =>
    setSearchParams(withFilters(searchParams, { q }), { replace: true });

  const sorted = useMemo(
    () =>
      [...requests].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      ),
    [requests],
  );

  const filtered = useMemo(() => {
    const needle = filters.q.trim().toLowerCase();
    return sorted.filter((r) => {
      if (filters.status !== 'all' && r.status !== filters.status) return false;
      if (!needle) return true;
      const op = getOperation(r.operationId, manifests);
      const title = describeBeyondCatalogRequest(r)
        ? beyondCatalogTitle(r)
        : (op?.title ?? provisionRequestTitle(r));
      const meta = getServiceMeta(r.service);
      const targetName = inventory?.resources.find((res) => res.address === r.targetAddress)?.name;
      return (
        title.toLowerCase().includes(needle) ||
        meta.displayName.toLowerCase().includes(needle) ||
        (targetName ?? '').toLowerCase().includes(needle) ||
        r.targetAddress.toLowerCase().includes(needle) ||
        userName(r.requester).toLowerCase().includes(needle)
      );
    });
  }, [sorted, manifests, inventory, filters]);

  const isFiltered = filters.status !== 'all' || filters.q.trim() !== '';

  return (
    <div className="apv">
      {/* S-09: visually-hidden polite live region — announces a successful
          approve (which otherwise just silently drops the card) to
          screen-reader users. Always mounted so the SAME node's text change
          is what triggers the announcement, not its presence. */}
      <p className="apv__sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
      <header className="apv__head">
        <div className="apv__head-main">
          <p className="page-eyebrow">Review queue</p>
          <h1 className="apv__title">Approvals</h1>
          <p className="apv__subtitle">
            Review each change and its Terraform diff. Nothing applies without your approval.
          </p>
        </div>
        {/* Data-authority header meta (Ledger contract #4) — only the total
            this page already has on hand once loaded; omitted while loading. */}
        {!loading && sorted.length > 0 && (
          <div className="apv__headmeta">
            <div>
              <b>{sorted.length}</b> pending
            </div>
          </div>
        )}
      </header>

      {error && (
        <p className="apv__error" role="alert">
          {error}
        </p>
      )}

      {!loading && sorted.length > 0 && (
        <div className="apv__filters">
          <SearchBar
            value={filters.q}
            onChange={setQuery}
            placeholder="Search the queue"
            ariaLabel="Search the approvals queue"
          />
          <select
            className="apv__status-select"
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
        <p className="apv__empty">Loading…</p>
      ) : inventory === undefined || sorted.length === 0 ? (
        <p className="apv__empty">Nothing waiting for your approval.</p>
      ) : filtered.length === 0 ? (
        <p className="apv__empty">
          No pending requests match these filters.
          {isFiltered && (
            <>
              {' '}
              <button
                type="button"
                className="apv__clear"
                onClick={() => setSearchParams(new URLSearchParams(), { replace: true })}
              >
                Clear filters
              </button>
            </>
          )}
        </p>
      ) : (
        // isPending: dimmed for the brief low-priority commit after a
        // mutation patches the list — same affordance/values as
        // CommandPalette's cmdp__list--stale.
        <div
          className={isPending ? 'apv__list apv__list--pending' : 'apv__list'}
          aria-busy={isPending}
        >
          {filtered.map((r) => (
            <ReviewCard
              key={r.id}
              request={r}
              manifests={manifests}
              inventory={inventory}
              onApprove={approve}
              rejecting={rejectingId === r.id}
              onStartReject={startReject}
              onCancelReject={cancelReject}
              onConfirmReject={confirmReject}
              busy={busyId === r.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
