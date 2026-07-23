import { useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import * as Popover from '@radix-ui/react-popover';
import type { ChangeRequest } from '@/types';
import { api } from '@/lib/api';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { useCurrentUser } from '@/lib/session';
import { getServiceMeta } from '@/lib/serviceMeta';
import './Notifications.css';

interface Note {
  id: string;
  requestId: string;
  tone: 'wait' | 'done' | 'fail' | 'info';
  title: string;
  detail: string;
  at: string;
}

function label(req: ChangeRequest): string {
  return getServiceMeta(req.service).displayName;
}

function pr(req: ChangeRequest): string {
  return req.prNumber ? `PR #${req.prNumber}` : 'Request';
}

/** Turn a request the user owns into a status line for their bell. */
function ownNote(req: ChangeRequest): Note {
  const svc = label(req);
  const base = { id: `own-${req.id}`, requestId: req.id, at: req.updatedAt };
  switch (req.status) {
    case 'APPLIED':
    case 'NOOP':
      return { ...base, tone: 'done', title: `Applied: ${svc}`, detail: `${pr(req)} · your change is live` };
    case 'REJECTED':
      return { ...base, tone: 'fail', title: `Rejected: ${svc}`, detail: `${pr(req)} · a reviewer declined it` };
    case 'APPLY_FAILED':
    case 'DIGEST_MISMATCH':
      return { ...base, tone: 'fail', title: `Apply failed: ${svc}`, detail: `${pr(req)} · needs attention` };
    case 'AWAITING_DEPLOY_APPROVAL':
      return { ...base, tone: 'wait', title: `Scheduled: ${svc}`, detail: `${pr(req)} · approved, waiting for its window` };
    case 'WINDOW_EXPIRED':
      // (api-mode only) — the AWAITING_DEPLOY_APPROVAL case
      // above is the template, toned like the
      // apply-failed cases: this needs a human to re-window or cancel.
      return { ...base, tone: 'fail', title: `Window expired: ${svc}`, detail: `${pr(req)} · re-window or cancel` };
    case 'NEEDS_ENGINEER':
      return { ...base, tone: 'info', title: `Routed to engineer: ${svc}`, detail: `${pr(req)} · an engineer will author it` };
    case 'AWAITING_CODE_REVIEW': {
      const req_n = req.approvalsRequired ?? 1;
      const have = req.approvals?.length ?? 0;
      return {
        ...base,
        tone: 'wait',
        title: `Awaiting review: ${svc}`,
        detail: `${pr(req)} · ${have}/${req_n} approval${req_n > 1 ? 's' : ''}`,
      };
    }
    default:
      return { ...base, tone: 'info', title: `Update: ${svc}`, detail: `${pr(req)} · ${req.status}` };
  }
}

/** A request awaiting THIS user's approval. */
function approvalNote(req: ChangeRequest): Note {
  return {
    id: `appr-${req.id}`,
    requestId: req.id,
    tone: 'wait',
    title: `${pr(req)} awaiting your approval`,
    detail: `${label(req)} · requested change needs your review`,
    at: req.updatedAt,
  };
}

/**
 * In-app notifications bell. Derives recent status items for the signed-in user
 * from the mock API: pending approvals (for approvers/leads) and updates on the
 * user's own requests. Each item carries a subtle "→ #ops-changes" marker — a
 * mock of the Slack/Teams echo every change also posts (CONCEPT.md).
 */
export function Notifications(): JSX.Element {
  // Live identity — a sign-out (this tab or another) or an admin
  // edit to this account is reflected without a navigation.
  const user = useCurrentUser();
  const [open, setOpen] = useState(false);
  const [own, setOwn] = useState<ChangeRequest[]>([]);
  const [pending, setPending] = useState<ChangeRequest[]>([]);

  // The bell lives in AppShell and never unmounts on a project switch.
  const projectId = useActiveProjectId();

  // Load on mount, on a user or project change, and again whenever the panel
  // toggles. The old effect was mount-only, so a bell opened minutes later
  // showed stale data; keying on `open` re-runs the fetch so the panel is
  // fresh each time it opens. (UIUX-13)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const [mine, toApprove] = await Promise.all([
        api.listRequests(user.id),
        api.listPendingApprovals(user),
      ]);
      if (!alive) return;
      setOwn(mine);
      setPending(toApprove);
    })();
    return () => {
      alive = false;
    };
  }, [user.id, open, projectId]);

  const notes = useMemo<Note[]>(() => {
    const items = [...pending.map(approvalNote), ...own.map(ownNote)];
    items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
    return items.slice(0, 8);
  }, [pending, own]);

  // The badge counts exactly what the panel shows, so the two never disagree —
  // previously the badge showed only pending approvals while the panel also
  // listed the user's own updates. (UIUX-13)
  const count = notes.length;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className="notif__bell"
        aria-label={count > 0 ? `Notifications, ${count} recent` : 'Notifications'}
      >
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path
            d="M12 3a5 5 0 0 0-5 5v3.2c0 .5-.2 1-.6 1.4L5 14.2c-.7.7-.2 1.9.8 1.9h12.4c1 0 1.5-1.2.8-1.9l-1.4-1.6a2 2 0 0 1-.6-1.4V8a5 5 0 0 0-5-5Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinejoin="round"
          />
          <path d="M10 19a2 2 0 0 0 4 0" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
        {count > 0 && <span className="notif__count" aria-hidden="true">{count}</span>}
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="notif__panel"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          // This is a passive list, not a modal dialog. Radix Popover.Content
          // defaults role="dialog", but it spreads consumer props last, so this
          // downgrades it to a labelled group — dropping the dialog semantics
          // the old hand-rolled panel wrongly claimed.
          role="group"
          aria-label="Notifications"
        >
          <header className="notif__head">
            <span className="notif__title">Notifications</span>
            <span className="notif__chat" title="Every change is echoed to team chat">→ #ops-changes</span>
          </header>

          {notes.length === 0 ? (
            <p className="notif__empty">You're all caught up.</p>
          ) : (
            <ul className="notif__list">
              {notes.map((n) => (
                <li key={n.id} className="notif__item">
                  <Link className="notif__link" to={`/requests/${n.requestId}`} onClick={() => setOpen(false)}>
                    <span className={`notif__dot notif__dot--${n.tone}`} aria-hidden="true" />
                    <span className="notif__body">
                      <span className="notif__item-title">{n.title}</span>
                      <span className="notif__item-detail">{n.detail}</span>
                      <span className="notif__sent" aria-hidden="true">sent to #ops-changes</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default Notifications;
