import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { authClient } from '@/lib/api';
import { usePendingCount } from '@/lib/pendingChanges';
import { loadPendingCountVia } from '@/features/admin/pendingChangesFlow';
import { useServerInfo } from '@/components/AdvisoryGate';
import './PendingChangesBanner.css';

/**
 * App-wide (within the admin area — mounted once in AdminLayout so every
 * admin tab shows it) banner surfacing the dual-control queue's pending
 * count. Counts ccp-api's real queue once it serves the pendingChanges
 * flow (GET /admin/config-changes via pendingChangesFlow.ts); otherwise the
 * local store, via {@link usePendingCount} (a real `useSyncExternalStore`
 * binding — FE-7) so a same-tab propose/ack/reject re-renders this banner
 * immediately instead of only after the admin leaves and re-enters the
 * admin area. Admins-only by construction: AdminLayout itself only renders
 * behind AdminGate. Renders nothing at 0 — no empty banner taking up space
 * when there's nothing to review.
 */
export function PendingChangesBanner(): JSX.Element | null {
  const { can } = useServerInfo();
  const authoritative = can('pendingChanges');
  const [serverCount, setServerCount] = useState(0);
  // FE-7 — AdminLayout mounts this banner ONCE for the whole admin area (the
  // nested admin routes swap under it, not around it), so a mount-only fetch
  // never saw anything decided/proposed on another admin tab. Re-keying on
  // the route path refetches every time the admin area's sub-route changes —
  // e.g. leaving the queue tab after an ack/reject, or landing on a tab after
  // a fresh proposal elsewhere — the exact "leaves and re-enters" cadence
  // the finding names, without needing every propose/ack/reject call site
  // (scattered across SettingsAdmin/UsersAdmin/RiskAdmin/PendingChanges) to
  // know about this banner.
  const location = useLocation();

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
  }, [authoritative, location.pathname]);

  const mockCount = usePendingCount();
  const count = authoritative ? serverCount : mockCount;
  if (count === 0) return null;
  return (
    <Link to="/admin/pending-changes" className="pending-banner" role="status">
      <span className="pending-banner__dot" aria-hidden="true" />
      <strong className="pending-banner__count">{count}</strong> pending config{' '}
      {count === 1 ? 'change' : 'changes'} awaiting a second admin
    </Link>
  );
}

export default PendingChangesBanner;
