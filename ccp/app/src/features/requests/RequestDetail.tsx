import { useEffect, useState, type FormEvent } from 'react';
import type { JSX } from 'react';
import { Link, useParams } from 'react-router-dom';
import type {
  ChangeRequest,
  Inventory,
  RequestStatus,
  Schedule,
  ServiceManifest,
  User,
} from '@/types';
import { api, authClient } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { canRequestAgain, requestAgainPath } from '@/lib/requestAgain';
import type { RequestFeasibility } from '@/lib/httpApi';
import { resolveName } from '@/lib/accounts';
import { useCurrentUser } from '@/lib/session';
import { getOperation } from '@/lib/interpreter';
import { formatProjectTime } from '@/lib/datetime';
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
import {
  hasFeasibility,
  feasibilityNotice,
  type FeasibilityFields,
} from '@/lib/requestFeasibility';
import { canSignApprovalStep } from '@/lib/approvalLadder';
import { canApprove } from '@/lib/permissions';
import { changeSetRequirement, exposureForTier, isChangeSet, itemsOf } from '@/lib/changeSet';
import { DiffView } from '@/components/DiffView';
import { FullBlockDiff } from '@/components/FullBlockDiff';
import { useFullBlockDiff } from '@/components/useFullBlockDiff';
import { ChangeSetView } from '@/components/ChangeSetView';
import { requestToYaml } from '@/lib/yaml';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { RiskBadge } from '@/components/ui/RiskBadge';
import { AccessBadge } from '@/components/ui/AccessBadge';
import { MacdTag } from '@/components/ui/MacdTag';
import { StatusBadge } from '@/components/ui/StatusBadge';
import { Button } from '@/components/ui/Button';
import { ApprovalLadder } from '@/components/ui/ApprovalLadder';
import {
  defaultWindowAt,
  isoToLocalInput,
  localInputToIso,
  scheduleError,
} from '@/features/request/SchedulePicker';
import { canCancelRequest, cancelRequestVia, coolingTimeRemaining } from './coolingFlow';
import { hasPlanContent, PlanSummaryBlock } from './PlanSummaryPanel';
import {
  canCancelWindowedRequest,
  canRewindowRequest,
  cancelWindowedRequestVia,
  rewindowRequestVia,
  windowCountdown,
  windowGateSummary,
} from './windowFlow';
import { Timeline } from './Timeline';
import './requests.css';

/** Deterministic phase tracks — the horizontal stepper above the timeline. */
const NORMAL_PHASES = [
  'Submitted',
  'Checks',
  'Plan ready',
  'Awaiting code review',
  'Approved / Merged',
  'Awaiting deploy',
  'Applying',
  'Applied',
];

const ENGINEER_PHASES = ['Submitted', 'With an engineer', 'Authored & reviewed', 'Applied'];

/** Which phase index a status sits at on the normal track, and whether it stalled there. */
const NORMAL_MAP: Record<RequestStatus, { i: number; failed?: boolean }> = {
  DRAFT: { i: 0 },
  SUBMITTED: { i: 0 },
  GENERATING: { i: 1 },
  CHECKS_RUNNING: { i: 1 },
  PLAN_READY: { i: 2 },
  AWAITING_CODE_REVIEW: { i: 3 },
  CHANGES_REQUESTED: { i: 3 },
  CODE_APPROVED: { i: 4 },
  MERGED: { i: 4 },
  AWAITING_DEPLOY_APPROVAL: { i: 5 },
  APPLYING: { i: 6 },
  APPLIED: { i: 7 },
  NOOP: { i: 7 },
  APPLY_FAILED: { i: 6, failed: true },
  DIGEST_MISMATCH: { i: 6, failed: true },
  REJECTED: { i: 3, failed: true },
  NEEDS_ENGINEER: { i: 1 },
  WITHDRAWN: { i: 0, failed: true },
  // Cooling-off (api-mode only): fully approved, holding
  // before it applies — closest existing phase is "Awaiting deploy" (i:5);
  // there is no dedicated "cooling" phase in this fixed 8-step track.
  APPROVED_COOLING: { i: 5 },
  // Stopped during that cooling window, or during/after a maintenance window.
  CANCELLED: { i: 5, failed: true },
  // (api-mode only): a maintenance window closed unapplied —
  // same phase as AWAITING_DEPLOY_APPROVAL (it never left "awaiting deploy"),
  // flagged stalled like CANCELLED.
  WINDOW_EXPIRED: { i: 5, failed: true },
};

interface StepperModel {
  phases: string[];
  currentIndex: number;
  failed: boolean;
}

function stepperModel(status: RequestStatus): StepperModel {
  if (status === 'NEEDS_ENGINEER') {
    return { phases: ENGINEER_PHASES, currentIndex: 1, failed: false };
  }
  const cell = NORMAL_MAP[status];
  return { phases: NORMAL_PHASES, currentIndex: cell.i, failed: cell.failed ?? false };
}

function StatusStepper({ status }: { status: RequestStatus }): JSX.Element {
  const { phases, currentIndex, failed } = stepperModel(status);
  return (
    <ol className="stepper" aria-label="Request progress">
      {phases.map((label, i) => {
        const state =
          i < currentIndex
            ? 'done'
            : i === currentIndex
              ? failed
                ? 'failed'
                : 'current'
              : 'pending';
        return (
          <li key={label} className={`stepper__step stepper__step--${state}`}>
            <span className="stepper__dot" aria-hidden="true" />
            <span className="stepper__label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function userName(id: string): string {
  return resolveName(id);
}

function fullTime(iso: string): string {
  return formatProjectTime(iso);
}

/**
 * The APPROVALS box (F-03/F-04/S-08: adopts the shared stepper — progress,
 * WHO signed, WHAT KIND of signer is next, and whether THIS viewer could
 * sign it). Informational only: this page has no Approve button of its own
 * (that verb lives in the queue), so `viewerCanSign` here answers "is this
 * your move" rather than offering an action.
 */
function ApprovalsBlock({
  request,
  currentUser,
}: {
  request: ChangeRequest;
  currentUser: User;
}): JSX.Element {
  const nextStep = request.nextApprovalStep;
  // Same gate as the queue's `mayApprove` (lib/permissions.ts#canApprove +
  // the ladder-seniority check) — this page just SHOWS the answer, never
  // acts on it.
  const viewerCanSign =
    canApprove(currentUser, request) &&
    (nextStep === undefined
      ? true
      : nextStep !== null && canSignApprovalStep(nextStep, currentUser.role));

  return (
    <section className="rd-approvals">
      <h2 className="rd-section-title">Approvals</h2>
      <ApprovalLadder
        required={request.approvalsRequired ?? 0}
        approvals={request.approvals ?? []}
        nextStep={nextStep}
        schedule={request.schedule}
        viewerCanSign={viewerCanSign}
        viewerIsOwnRequest={request.requester === currentUser.id}
        size="detail"
      />
    </section>
  );
}

export interface CoolingPanelProps {
  request: Pick<ChangeRequest, 'status' | 'requester' | 'earliestApplyAt'>;
  currentUser: { id: string; role: string; isAdmin?: boolean };
  onCancel: () => void;
  busy: boolean;
  error?: string | null;
}

/**
 * The cooling-off banner. Renders only for
 * APPROVED_COOLING — null for every other status, including CANCELLED
 * (shown via the StatusBadge chip + the server's own 'cancelled' timeline
 * event, not a standing banner). Exported so its render shape — in
 * particular the Cancel button's visibility rule — is directly testable via
 * renderToStaticMarkup without mounting the whole data-fetching page
 * (mirrors AccountRow's prop-driven testability, advisoryGate.test.ts).
 */
export function CoolingPanel({
  request,
  currentUser,
  onCancel,
  busy,
  error,
}: CoolingPanelProps): JSX.Element | null {
  if (request.status !== 'APPROVED_COOLING') return null;
  const canCancel = canCancelRequest(request, currentUser);
  const deadline = request.earliestApplyAt;
  return (
    <section className="rd-cooling" role="note">
      <p className="rd-cooling__text">
        Fully approved under the single-approver interim profile — cooling off until{' '}
        <strong>{formatProjectTime(deadline)}</strong>
        {deadline ? ` (${coolingTimeRemaining(deadline)})` : ''}.
      </p>
      {canCancel && (
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          {busy ? 'Cancelling…' : 'Cancel this change'}
        </Button>
      )}
      {error && (
        <p className="rd-cooling__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export interface WindowPanelProps {
  request: Pick<ChangeRequest, 'status' | 'requester' | 'schedule' | 'earliestApplyAt'>;
  currentUser: { id: string; role: string; isAdmin?: boolean };
  onCancel: () => void;
  onRewindow: (at: string, endAt?: string) => void;
  cancelBusy: boolean;
  rewindowBusy: boolean;
  cancelError?: string | null;
  rewindowError?: string | null;
  /** Injectable for tests; defaults to Date.now(). No client timer — mirrors
   * `coolingTimeRemaining`'s "computed once at render, re-settles on the next
   * GET" doctrine ("lazily settled" philosophy, client-side). */
  now?: number;
}

/**
 * The gate-truth panel — mirrors {@link CoolingPanel}'s exact
 * shape/pattern (a merged precedent this design explicitly asks to
 * follow) for the window states CoolingPanel doesn't cover: renders for
 * WINDOW_EXPIRED or an AWAITING_DEPLOY_APPROVAL request with a
 * `schedule.kind:'window'` (a freeze-held `kind:'now'` row —
 * "degenerate always-open window" — has no window to show and gets no panel
 * here, same as today). Cancel and re-window share this ONE panel because a
 * request is never simultaneously APPROVED_COOLING and window-parked — the two
 * panels are for disjoint lifecycle phases, not duplicated UI for the same one.
 */
export function WindowPanel({
  request,
  currentUser,
  onCancel,
  onRewindow,
  cancelBusy,
  rewindowBusy,
  cancelError,
  rewindowError,
  now = Date.now(),
}: WindowPanelProps): JSX.Element | null {
  const schedule = request.schedule;
  const applicable =
    request.status === 'WINDOW_EXPIRED' ||
    (request.status === 'AWAITING_DEPLOY_APPROVAL' && schedule?.kind === 'window');
  // Hooks run unconditionally, before the early return below (rules of hooks) —
  // the rewindow mini-form's controlled input needs its own state regardless of
  // whether this render ends up returning null.
  const [rewindowAt, setRewindowAt] = useState<string>(() => isoToLocalInput(defaultWindowAt(now)));

  if (!applicable || schedule?.kind !== 'window') return null;

  const closed = request.status === 'WINDOW_EXPIRED';
  const summary = windowGateSummary(schedule, request.earliestApplyAt, now);
  const windowEndDisplay = schedule.endAt ?? schedule.at;
  const canCancel = canCancelWindowedRequest(request, currentUser);
  const canRewindow = canRewindowRequest(request, currentUser, now);

  const text = closed
    ? `Maintenance window closed at ${formatProjectTime(windowEndDisplay)} — re-window or cancel to continue.`
    : summary === 'cooling'
      ? `Cooling off under the interim profile until ${formatProjectTime(request.earliestApplyAt)} (${windowCountdown(request.earliestApplyAt!, now)}) — window opens ${formatProjectTime(schedule.at)}.`
      : summary === 'before_window'
        ? `Window opens ${formatProjectTime(schedule.at)} (in ${windowCountdown(schedule.at, now)}) — closes ${formatProjectTime(windowEndDisplay)}.`
        : summary === 'open'
          ? `Window open now — closes ${formatProjectTime(windowEndDisplay)}.`
          : `Window closed at ${formatProjectTime(windowEndDisplay)} — refresh to see the latest status.`;

  const newSchedule: Schedule = { kind: 'window', at: localInputToIso(rewindowAt) ?? '' };
  const rewindowInputError = scheduleError(newSchedule, now);

  const handleRewindowSubmit = (e: FormEvent): void => {
    e.preventDefault();
    const at = localInputToIso(rewindowAt);
    if (!at || rewindowInputError) return;
    onRewindow(at);
  };

  return (
    <section className="rd-window" role="note">
      <p className="rd-window__text">{text}</p>

      {(canCancel || canRewindow) && (
        <div className="rd-window__actions">
          {canRewindow && (
            <form className="rd-window__form" onSubmit={handleRewindowSubmit}>
              <input
                type="datetime-local"
                className="rd-window__input"
                value={rewindowAt}
                aria-label="New maintenance window date and time"
                aria-invalid={rewindowInputError !== undefined}
                onChange={(e) => setRewindowAt(e.target.value)}
              />
              <Button variant="ghost" disabled={rewindowBusy || rewindowInputError !== undefined}>
                {rewindowBusy ? 'Re-windowing…' : 'Re-window'}
              </Button>
            </form>
          )}
          {canCancel && (
            <Button variant="ghost" onClick={onCancel} disabled={cancelBusy}>
              {cancelBusy ? 'Cancelling…' : 'Cancel this change'}
            </Button>
          )}
        </div>
      )}

      {rewindowInputError && canRewindow && (
        <p className="rd-window__error" role="alert">
          {rewindowInputError}
        </p>
      )}
      {rewindowError && (
        <p className="rd-window__error" role="alert">
          {rewindowError}
        </p>
      )}
      {cancelError && (
        <p className="rd-window__error" role="alert">
          {cancelError}
        </p>
      )}
    </section>
  );
}

/**
 * "Request again": on a TERMINAL request, one click
 * reopens the same form pre-seeded from this request's params (`?from=`), a
 * fresh id, a fresh justification, live re-validation against the current
 * manifest. Null for every non-terminal status — parked/waiting requests have
 * their own verbs (cancel/rewindow), never a duplicate. Exported for the same
 * render-shape testability as CoolingPanel.
 */
export function RequestAgainLink({
  request,
}: {
  request: Pick<ChangeRequest, 'id' | 'service' | 'operationId' | 'status'>;
}): JSX.Element | null {
  if (!canRequestAgain(request)) return null;
  return (
    <Link className="rd__again" to={requestAgainPath(request)}>
      Request again
    </Link>
  );
}

export interface LinkPrPanelProps {
  request: Pick<ChangeRequest, 'status' | 'prUrl'>;
  currentUser: { id: string; role: string; isAdmin?: boolean };
  /** True only when a real ccp-api answers (authClient present) — the mock
   * has no link-pr verb, so the control never renders there. */
  serverCanLink: boolean;
  onLink: (prUrl: string) => void;
  busy: boolean;
  error?: string | null;
}

/**
 * The engineer-track loop closer's WRITE side: a Lead records the
 * fulfilling PR's URL on an open request, so the requester's "did anything
 * happen?" gets a link instead of a dead phase. Renders only for a Lead/admin,
 * in api-mode, on an OPEN status (NEEDS_ENGINEER — the headline case — or
 * AWAITING_CODE_REVIEW, the Stage-2 lane). The server re-enforces all of it:
 * lead-only, https-only, terminal statuses refused.
 */
export function LinkPrPanel({
  request,
  currentUser,
  serverCanLink,
  onLink,
  busy,
  error,
}: LinkPrPanelProps): JSX.Element | null {
  const [prUrl, setPrUrl] = useState(request.prUrl ?? '');
  const open = request.status === 'NEEDS_ENGINEER' || request.status === 'AWAITING_CODE_REVIEW';
  const senior = currentUser.role === 'lead' || currentUser.isAdmin === true;
  if (!serverCanLink || !open || !senior) return null;

  const valid = /^https:\/\/\S+$/.test(prUrl.trim());
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!valid) return;
    onLink(prUrl.trim());
  };

  return (
    <section className="rd-linkpr" role="note">
      <p className="rd-linkpr__text">
        {request.prUrl
          ? 'The engineering PR is linked — paste a new address to correct it.'
          : 'Working this request? Paste the engineering PR’s address so the requester can follow it.'}
      </p>
      <form className="rd-linkpr__form" onSubmit={submit}>
        <input
          type="url"
          className="rd-linkpr__input"
          value={prUrl}
          placeholder="https://github.com/…/pull/123"
          aria-label="Engineering PR address"
          onChange={(e) => setPrUrl(e.target.value)}
        />
        <Button variant="ghost" disabled={busy || !valid}>
          {busy ? 'Linking…' : request.prUrl ? 'Update the PR link' : 'Link the PR'}
        </Button>
      </form>
      {error && (
        <p className="rd-linkpr__error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export interface FeasibilityBannerProps {
  /** The fields — from either the live GET .../feasibility fetch or
   * the submit-time snapshot on the ChangeRequest itself; undefined in
   * mock-mode (the fields are simply absent there) or while the live fetch
   * hasn't resolved and no snapshot exists either. */
  feasibility: FeasibilityFields | undefined;
}

/** Renders one of the two honesty notices, or nothing. Exported for
 * the same render-shape-testability reason as {@link CoolingPanel}. */
export function FeasibilityBanner({ feasibility }: FeasibilityBannerProps): JSX.Element | null {
  if (!feasibility) return null;
  const notice = feasibilityNotice(feasibility);
  if (!notice) return null;
  return (
    <p className={`rd-feasibility rd-feasibility--${notice.tone}`} role="alert">
      {notice.text}
    </p>
  );
}

export function RequestDetail(): JSX.Element {
  const { id } = useParams();
  const [request, setRequest] = useState<ChangeRequest | undefined>(undefined);
  const [manifests, setManifests] = useState<ServiceManifest[]>([]);
  const [inventory, setInventory] = useState<Inventory | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  // The LIVE-recomputed feasibility (api-mode only; undefined in
  // mock-mode, where the endpoint doesn't exist and authClient is null).
  const [feasibility, setFeasibility] = useState<RequestFeasibility | undefined>(undefined);
  const [cancelBusy, setCancelBusy] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [rewindowBusy, setRewindowBusy] = useState(false);
  const [rewindowError, setRewindowError] = useState<string | null>(null);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);
  // Live — passed to CoolingPanel/WindowPanel below.
  const currentUser = useCurrentUser();
  const projectId = useActiveProjectId();

  useEffect(() => {
    let active = true;
    void Promise.all([
      id ? api.getRequest(id) : Promise.resolve(undefined),
      api.listManifests(),
      api.getInventory(),
      // Best-effort: a failed live fetch (e.g. a request the account can no
      // longer see) just falls back to the submit-time snapshot already on
      // the ChangeRequest itself, never a page-level error.
      id && authClient
        ? authClient.getRequestFeasibility(id).catch(() => undefined)
        : Promise.resolve(undefined),
    ]).then(([r, m, inv, feas]) => {
      if (!active) return;
      setRequest(r);
      setManifests(m);
      setInventory(inv);
      setFeasibility(feas);
      setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [id, projectId]);

  const handleCancel = async (): Promise<void> => {
    if (!request || !authClient) return;
    setCancelBusy(true);
    setCancelError(null);
    const outcome = await cancelRequestVia(authClient, request.id);
    if (outcome.ok) {
      setRequest(outcome.request);
    } else {
      setCancelError(outcome.reason);
      // STATE_CONFLICT (lazy settlement): the request's true current
      // state came back with the rejection — show it instead of leaving a
      // stale "still cooling" view next to an error nobody can act on.
      if (outcome.refetched) setRequest(outcome.refetched);
    }
    setCancelBusy(false);
  };

  // WindowPanel's own cancel (widened status set — a request is
  // never simultaneously APPROVED_COOLING and window-parked, so sharing
  // cancelBusy/cancelError with CoolingPanel's handler above is safe; each
  // panel calls its OWN "via" helper for a clearer contract per module).
  const handleWindowCancel = async (): Promise<void> => {
    if (!request || !authClient) return;
    setCancelBusy(true);
    setCancelError(null);
    const outcome = await cancelWindowedRequestVia(authClient, request.id);
    if (outcome.ok) {
      setRequest(outcome.request);
    } else {
      setCancelError(outcome.reason);
      if (outcome.refetched) setRequest(outcome.refetched);
    }
    setCancelBusy(false);
  };

  const handleRewindow = async (at: string, endAt?: string): Promise<void> => {
    if (!request || !authClient) return;
    setRewindowBusy(true);
    setRewindowError(null);
    const outcome = await rewindowRequestVia(authClient, request.id, at, endAt);
    if (outcome.ok) {
      setRequest(outcome.request);
    } else {
      setRewindowError(outcome.reason);
      if (outcome.refetched) setRequest(outcome.refetched);
    }
    setRewindowBusy(false);
  };

  // A Lead records the fulfilling engineering PR. The server is the
  // authority (lead-only, https-only, refused on terminal statuses) — this
  // just surfaces its answer.
  const handleLinkPr = async (prUrl: string): Promise<void> => {
    if (!request || !authClient) return;
    setLinkBusy(true);
    setLinkError(null);
    const outcome = await authClient.linkRequestPr(request.id, { prUrl });
    if (outcome.ok) setRequest(outcome.request);
    else setLinkError(outcome.reason);
    setLinkBusy(false);
  };

  // Derived + the full-block hook must run before any early return (rules of hooks).
  const op = request ? getOperation(request.operationId, manifests) : undefined;
  const blockDiff = useFullBlockDiff(op, request?.params ?? {}, request?.targetAddress ?? '');

  if (loading) {
    return <p className="reqs__empty">Loading…</p>;
  }
  if (!request) {
    return (
      <div className="reqs">
        <Breadcrumbs items={[{ label: 'My requests', to: '/requests' }, { label: 'Not found' }]} />
        <p className="reqs__empty">Request not found.</p>
      </div>
    );
  }

  const beyondCatalog = describeBeyondCatalogRequest(request);
  // A schema-generated provision request also has no manifest op behind its
  // id — its stored params render as a parameter sheet (section below).
  const provision = describeProvisionRequest(request);
  const title = beyondCatalog
    ? beyondCatalogTitle(request)
    : (op?.title ?? provisionRequestTitle(request));
  const isEngineer = request.status === 'NEEDS_ENGINEER';

  // Phase B: a request may enact several operations as ONE change set. `itemsOf` is the
  // canonical, always-non-empty item list — length 1 for a single-op request (which then
  // renders byte-identically to before), N for a true set. When it's a set the header badges
  // and the "What changes"/diff area disclose the WHOLE set and the STRICTEST-combined
  // requirement the server enforces, never just the primary operation (items[0]).
  const items = itemsOf(request);
  const isSet = isChangeSet(request);
  const combined = isSet ? changeSetRequirement(items) : undefined;

  const targetName = inventory?.resources.find(
    (res) => res.address === request.targetAddress,
  )?.name;

  const summary = op && inventory ? plainSummary(op, request.params, inventory) : undefined;
  // Prefer the diff pinned at submit; fall back to regeneration for
  // legacy/seed requests that predate pinning.
  const diff =
    request.pinnedDiff ??
    (op && inventory ? generateDiff(op, request.params, inventory) : undefined);

  const schedule = request.schedule ?? { kind: 'now' };
  const scheduleText =
    schedule.kind === 'window'
      ? `Scheduled to apply ${fullTime(schedule.at)}${schedule.endAt ? ` – ${fullTime(schedule.endAt)}` : ''}`
      : 'Applies immediately after approval';

  const currentLabel = request.prNumber ? `#${request.prNumber} · ${title}` : title;

  // Prefer the LIVE-recomputed feasibility when the fetch resolved;
  // fall back to the submit-time snapshot already on the request itself.
  // Both are absent in mock-mode (hasFeasibility guards on field presence,
  // not on isApiMode, per lib/requestFeasibility.ts's honesty rule).
  const effectiveFeasibility: FeasibilityFields | undefined =
    feasibility ?? (hasFeasibility(request) ? request : undefined);

  return (
    <div className="rd">
      <Breadcrumbs items={[{ label: 'My requests', to: '/requests' }, { label: currentLabel }]} />

      <header className="rd__head">
        <h1 className="rd__title">{title}</h1>
        <div className="rd__badges">
          <StatusBadge status={request.status} />
          {isSet && combined ? (
            // A set's top-level macd/risk/exposure are only items[0]'s — show the COMBINED
            // picture instead: how many operations, and the strictest review tier across them.
            <>
              <span className="rd__set-count" title="Operations in this one change set">
                {items.length} operations
              </span>
              <AccessBadge exposure={exposureForTier(combined.tier)} />
            </>
          ) : (
            <>
              <MacdTag macd={request.macd} />
              <RiskBadge risk={request.risk} />
              <AccessBadge exposure={request.exposure} />
            </>
          )}
          <RequestAgainLink request={request} />
        </div>
      </header>

      <div className="rd__stepper-band">
        {isEngineer && (
          <p className="rd__track-note">
            Engineer track — an engineer authors and reviews the Terraform. You still write no code.
          </p>
        )}
        <StatusStepper status={request.status} />
      </div>

      <div className="rd__grid">
        <div className="rd__main">
          <dl className="rd__facts">
            <dt>{isSet ? 'Changes' : 'Target'}</dt>
            <dd>
              {isSet ? (
                <span>{items.length} operations in one change</span>
              ) : (
                <>
                  {targetName ? <span className="rd__target-name">{targetName}</span> : null}
                  <span className="rq__mono">{request.targetAddress}</span>
                </>
              )}
            </dd>
            <dt>Requester</dt>
            <dd>{userName(request.requester)}</dd>
            {request.prUrl && (
              <>
                <dt>Pull request</dt>
                <dd>
                  <a href={request.prUrl} target="_blank" rel="noreferrer">
                    {request.prNumber ? `#${request.prNumber} · ` : ''}Track the engineering PR →
                  </a>
                </dd>
              </>
            )}
          </dl>

          <p className="rd__justification">“{request.justification}”</p>

          <ApprovalsBlock request={request} currentUser={currentUser} />

          <FeasibilityBanner feasibility={effectiveFeasibility} />

          <CoolingPanel
            request={request}
            currentUser={currentUser}
            onCancel={() => void handleCancel()}
            busy={cancelBusy}
            error={cancelError}
          />

          <WindowPanel
            request={request}
            currentUser={currentUser}
            onCancel={() => void handleWindowCancel()}
            onRewindow={(at, endAt) => void handleRewindow(at, endAt)}
            cancelBusy={cancelBusy}
            rewindowBusy={rewindowBusy}
            cancelError={cancelError}
            rewindowError={rewindowError}
          />

          <LinkPrPanel
            request={request}
            currentUser={currentUser}
            serverCanLink={authClient !== null}
            onLink={(prUrl) => void handleLinkPr(prUrl)}
            busy={linkBusy}
            error={linkError}
          />

          {beyondCatalog && (
            // Task 1: getOperation(BEYOND_CATALOG_OP_ID) is undefined by design —
            // there is no manifest op, no diff, and no FullBlockDiff for this
            // request kind. Render the stored fields directly instead.
            <section className="rd-changes">
              <h2 className="rd-section-title">Beyond-catalog request</h2>
              <dl className="rd__facts">
                <dt>Kind</dt>
                <dd>{beyondCatalog.kindLabel}</dd>
                <dt>Service</dt>
                <dd className="rq__mono">{beyondCatalog.service}</dd>
                {beyondCatalog.resourceType && (
                  <>
                    <dt>Resource type</dt>
                    <dd className="rq__mono">{beyondCatalog.resourceType}</dd>
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
              <p className="rd-changes__summary">{beyondCatalog.summary}</p>
              <p className="rd-evidence__note">{BEYOND_CATALOG_NOTE}</p>
            </section>
          )}

          {provision && (
            // Schema-generated provision: getOperation() is undefined by
            // design here too — render the parameter sheet the requester
            // filled in, straight from the stored params.
            <section className="rd-changes">
              <h2 className="rd-section-title">The new resource, as requested</h2>
              <dl className="rd__facts">
                <dt>Resource type</dt>
                <dd className="rq__mono">{provision.resourceType}</dd>
                {provision.rows.map((row) => (
                  <div key={row.label} className="rd__facts-row">
                    <dt>{row.label}</dt>
                    <dd>{row.value}</dd>
                  </div>
                ))}
              </dl>
              {provision.rows.length === 0 && (
                <p className="rd-changes__summary">
                  No parameters were filled in — provider defaults throughout.
                </p>
              )}
              <p className="rd-evidence__note">{PROVISION_NOTE}</p>
            </section>
          )}

          {isSet && inventory && (
            // The whole change set: the combined requirement + EVERY operation, target and
            // diff — so an approver can never sign N operations while shown one.
            <section className="rd-changes">
              <h2 className="rd-section-title">What changes · {items.length} operations</h2>
              <ChangeSetView items={items} manifests={manifests} inventory={inventory} />
            </section>
          )}

          {!isSet && summary && (
            <section className="rd-changes">
              <h2 className="rd-section-title">What changes</h2>
              <p className="rd-changes__summary">{summary}</p>
            </section>
          )}

          {!isSet && (blockDiff || diff) && (
            <section className="rd-diff">
              <h2 className="rd-section-title">
                {blockDiff ? 'The block being changed' : 'Generated Terraform'}
              </h2>
              {blockDiff ? (
                <FullBlockDiff diff={blockDiff} />
              ) : diff ? (
                <DiffView diff={diff} />
              ) : null}
            </section>
          )}

          {/* (visibility): what the CI `terraform plan` says this
              request does to the live environment — the learning + safety
              artifact, shown before any apply. Honest pending note when no
              plan has run; never fabricated. */}
          {!beyondCatalog && hasPlanContent(request.status, request.planSummary) && (
            <section className="rd-changes">
              <h2 className="rd-section-title">What the plan will do</h2>
              <PlanSummaryBlock status={request.status} planSummary={request.planSummary} />
            </section>
          )}

          <section className="rd-evidence">
            <h2 className="rd-section-title">Evidence chain</h2>
            <dl className="rd-evidence__grid">
              <dt>Approved commit</dt>
              <dd className="rq__mono">
                {request.headSha ?? <span className="rd-evidence__pending">pending apply</span>}
              </dd>
              <dt>Plan digest</dt>
              <dd className="rq__mono">
                {request.planDigest ?? <span className="rd-evidence__pending">pending apply</span>}
              </dd>
              <dt>Applied commit</dt>
              <dd className="rq__mono">
                {request.appliedSha ?? <span className="rd-evidence__pending">not applied</span>}
              </dd>
              <dt>Evidence record</dt>
              <dd>
                {request.evidenceUrl ? (
                  <a href={request.evidenceUrl} target="_blank" rel="noreferrer">
                    Object-Lock archive
                  </a>
                ) : (
                  <span className="rd-evidence__pending">created on apply</span>
                )}
              </dd>
            </dl>
            <p className="rd-evidence__note">
              The pipeline binds “plan reviewed = plan applied” and writes an immutable evidence
              record at apply time. These fields populate once the CI pipeline is armed.
            </p>
          </section>

          <section className="rd-schedule">
            <h2 className="rd-section-title">Schedule</h2>
            <p className="rd-schedule__text">
              <span
                className={`rd-schedule__chip rd-schedule__chip--${schedule.kind}`}
                aria-hidden="true"
              >
                {schedule.kind === 'window' ? 'Window' : 'Now'}
              </span>
              {scheduleText}
            </p>
          </section>

          <details className="rq-preview">
            <summary className="rq-preview__summary">Request record (YAML)</summary>
            <pre className="rq-preview__yaml">{requestToYaml(request)}</pre>
          </details>
        </div>

        <aside className="rd__timeline">
          <h2 className="rq__side-title">Timeline</h2>
          <Timeline events={request.events} />
        </aside>
      </div>
    </div>
  );
}
