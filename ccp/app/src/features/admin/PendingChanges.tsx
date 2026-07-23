import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { resolveName } from '@/lib/accounts';
import { authClient } from '@/lib/api';
import {
  ackPendingVia,
  loadPendingRowsVia,
  localPendingRows,
  rejectPendingVia,
  type PendingRow,
  type PendingRowStatus,
} from './pendingChangesFlow';
import { GateFieldset, SERVER_MODE, useServerInfo } from '@/components/AdvisoryGate';
import './pending-changes.css';

const STATUS_LABEL: Record<PendingRowStatus, string> = {
  PENDING: 'Pending',
  ACKED: 'Acknowledged',
  APPLIED: 'Applied',
  REJECTED: 'Rejected',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
};

function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * The dual-control queue tab (api spec / admin-multiproject). Lists
 * every pending change with its before→after, newest first. Server-backed
 * since ccp-api serves GET /admin/config-changes + ack/reject
 * (pendingChangesFlow.ts): acknowledging as a SECOND distinct admin applies
 * the proposal (the server refuses a self-ack with its own reason), rejecting
 * withdraws it. A decided item leaves the server's pending list — its
 * disposition lives in the audit chain — so the outcome is shown once, here.
 */
export function PendingChanges(): JSX.Element {
  const { can } = useServerInfo();
  const authoritative = can('pendingChanges');
  // Mode honesty: the local queue's ack/reject transitions genuinely work in
  // a mock build (lib/pendingChanges flips the item's status and records the
  // audit entry), so the decision buttons stay LIVE against this browser's
  // demo queue. An api build keeps the arming rule unchanged — the REAL
  // dual-control state machine (self-ack refusal, drift guard) is ccp-api's.
  const demo = SERVER_MODE === 'mock';
  // Synchronous local snapshot first (mock/server-render truth on first
  // paint); the effect swaps in the server's queue once authoritative.
  const [items, setItems] = useState<PendingRow[]>(localPendingRows);
  const [decided, setDecided] = useState<PendingRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = (): void => {
    void loadPendingRowsVia(authoritative, authClient)
      .then((rows) => setItems(rows))
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : 'Could not load pending changes.');
      });
  };
  useEffect(refresh, [authoritative]);

  async function decide(
    fn: () => Promise<PendingRow | undefined>,
  ): Promise<void> {
    setError(null);
    setDecided(null);
    setBusy(true);
    try {
      const row = await fn();
      if (row) setDecided(row);
      refresh();
    } catch (err) {
      // The server's own reason (e.g. "You cannot acknowledge your own
      // proposal.", "The target changed since this proposal was made.").
      setError(err instanceof Error ? err.message : 'Could not apply the decision.');
      refresh();
    } finally {
      setBusy(false);
    }
  }

  const pendingItems = items.filter((i) => i.status === 'PENDING');

  return (
    <div className="pending-changes">
      <div className="pending-changes__head">
        <h2 className="pending-changes__title">Pending changes</h2>
        <span className="pending-changes__note">
          {pendingItems.length} awaiting a decision · a proposed change waits for a second admin
          before it applies — the proposer can&rsquo;t acknowledge their own.
        </span>
      </div>

      {error && (
        <p className="pending-changes__msg pending-changes__msg--error" role="alert">
          {error}
        </p>
      )}
      {decided && (
        <p className="pending-changes__msg pending-changes__msg--ok" role="status">
          {STATUS_LABEL[decided.status]}: {decided.kind} · {decided.summary}
        </p>
      )}

      {items.length === 0 ? (
        <p className="settings__summary">No pending changes right now.</p>
      ) : (
        <ul className="pending-changes__list">
          {items.map((item) => (
            <li
              key={item.id}
              className={`pending-changes__item pending-changes__item--${item.status.toLowerCase()}`}
            >
              <div className="pending-changes__meta">
                <span className="pending-changes__kind">{item.kind}</span>
                <span className="pending-changes__by">
                  proposed by {resolveName(item.proposedBy)}
                </span>
                <span className="pending-changes__when">{when(item.proposedAt)}</span>
                <span className="pending-changes__status">{STATUS_LABEL[item.status]}</span>
              </div>
              <div className="pending-changes__diff">{item.summary}</div>
              {item.status === 'PENDING' && (
                <>
                  {/* Api build only: dimmed until ccp-api serves the flow —
                      the page banner above is the one explanation, no per-item
                      note repeated (mode honesty). */}
                  <GateFieldset disabled={!authoritative && !demo}>
                    <div className="pending-changes__actions">
                      <button
                        type="button"
                        className="pending-changes__ack"
                        disabled={busy}
                        onClick={() =>
                          void decide(() => ackPendingVia(authoritative, authClient, item.id))
                        }
                      >
                        Acknowledge
                      </button>
                      <button
                        type="button"
                        className="pending-changes__reject"
                        disabled={busy}
                        onClick={() =>
                          void decide(() => rejectPendingVia(authoritative, authClient, item.id))
                        }
                      >
                        Reject
                      </button>
                    </div>
                  </GateFieldset>
                  <p className="pending-changes__hint">
                    Expires {when(item.expiresAt)} if nobody decides.
                  </p>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default PendingChanges;
