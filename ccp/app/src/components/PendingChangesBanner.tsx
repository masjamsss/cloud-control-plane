import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Link } from 'react-router-dom';
import { authClient } from '@/lib/api';
import { pendingCount } from '@/lib/pendingChanges';
import { loadPendingCountVia } from '@/features/admin/pendingChangesFlow';
import { useServerInfo } from '@/components/AdvisoryGate';
import './PendingChangesBanner.css';

/**
 * App-wide (within the admin area — mounted once in AdminLayout so every
 * admin tab shows it) banner surfacing the dual-control queue's pending
 * count. Counts ccp-api's real queue once it serves the pendingChanges
 * flow (GET /admin/config-changes via pendingChangesFlow.ts); otherwise the
 * local store, read synchronously — exactly the pre-existing behavior, and
 * what keeps a server-string render (this repo's testing story) meaningful.
 * Admins-only by construction: AdminLayout itself only renders behind
 * AdminGate. Renders nothing at 0 — no empty banner taking up space when
 * there's nothing to review.
 */
export function PendingChangesBanner(): JSX.Element | null {
  const { can } = useServerInfo();
  const authoritative = can('pendingChanges');
  const [serverCount, setServerCount] = useState(0);

  useEffect(() => {
    if (!authoritative) return undefined;
    let alive = true;
    void loadPendingCountVia(authoritative, authClient)
      .then((n) => {
        if (alive) setServerCount(n);
      })
      .catch(() => {
        // A failed count read never blocks the admin area; the queue tab
        // itself surfaces the load error with its reason.
      });
    return () => {
      alive = false;
    };
  }, [authoritative]);

  const count = authoritative ? serverCount : pendingCount();
  if (count === 0) return null;
  return (
    <Link to="/admin/pending-changes" className="pending-banner" role="status">
      <span className="pending-banner__dot" aria-hidden="true" />
      <strong className="pending-banner__count">{count}</strong> pending config {count === 1 ? 'change' : 'changes'} awaiting a second admin
    </Link>
  );
}

export default PendingChangesBanner;
