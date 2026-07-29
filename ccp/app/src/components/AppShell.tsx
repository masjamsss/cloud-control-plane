import { Suspense, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { NavLink, Outlet, useMatches } from 'react-router-dom';
import { useCurrentUser } from '@/lib/session';
import { useActiveProjectId } from '@/lib/ProjectContext';
import { projectScopedPath } from '@/lib/legacyRoute';
import { OverflowNav, PrimaryNav, shellNavItems } from '@/components/ShellNav';
import { useSettings } from '@/lib/settings';
import { Notifications } from '@/components/Notifications';
import { AccountMenu } from '@/components/AccountMenu';
import { RouteSkeleton } from '@/components/RouteSkeleton';
import { CommandPalette } from '@/components/CommandPalette';
import { ProjectSwitcher } from '@/features/projects/ProjectSwitcher';
import { useInstanceIdentity } from '@/lib/instanceIdentity';
import './AppShell.css';

interface RouteHandle {
  title?: string;
}

// Computed once (module scope, not per-render): the shortcut hint reflects the
// viewer's own platform, macOS vs. everyone else.
const SHORTCUT_LABEL =
  typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘K' : 'Ctrl+K';

/** Set document.title from the deepest matched route's handle.title, joined
 * with the resolved instance name (baked → cached → runtime — `appName` is
 * the caller's live `useInstanceIdentity().name`, so a Settings rename
 * repaints the tab title immediately, no reload). */
function useDocumentTitle(appName: string): void {
  const matches = useMatches();
  useEffect(() => {
    const withTitle = [...matches]
      .reverse()
      .find((m) => (m.handle as RouteHandle | undefined)?.title);
    const title = (withTitle?.handle as RouteHandle | undefined)?.title;
    document.title = title ? `${title} · ${appName}` : appName;
  }, [matches, appName]);
}

export function AppShell(): JSX.Element {
  const identity = useInstanceIdentity();
  useDocumentTitle(identity.name);
  // Live — an admin grant/revoke or a sign-out in another tab
  // updates nav visibility (Approvals/Dashboard/Admin) without a navigation.
  const user = useCurrentUser();
  // LD-4: the same subscribed settings snapshot RequestForm/BulkRequestForm/
  // ResourceDetail already read for their own submit-time freeze checks —
  // reused here, read-only, so the freeze becomes visible estate-wide
  // (every route renders through AppShell) instead of only at the foot of
  // the request funnel's Review step.
  const settings = useSettings();
  const frozen = settings.changeFreeze;
  const [paletteOpen, setPaletteOpen] = useState(false);
  // UI-3: every nav target below is rendered PROJECT-SCOPED. Unscoped `to`
  // values made `isActive` structurally impossible and sent each click
  // through a full unmount → LegacyRedirect → remount cycle.
  const projectId = useActiveProjectId();

  // Cmd/Ctrl+K opens the command palette.
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const nav = shellNavItems(user);

  return (
    <div className="shell">
      <a href="#main-content" className="shell__skip">
        Skip to main content
      </a>
      <header className="shell__bar">
        <NavLink
          to={projectScopedPath(projectId, '/')}
          end
          className="shell__brand"
          aria-label={`${identity.name} home`}
        >
          <span className="shell__mark" aria-hidden="true">◆</span>
          {/* F-08: below ~480px the wordmark is hidden (CSS) so the shell
              stops scrolling sideways — the ◆ mark alone still carries the
              link, and the full name stays in the NavLink's aria-label
              above for a screen-reader user regardless of viewport. */}
          <span className="shell__wordmark">{identity.name}</span>
        </NavLink>

        <ProjectSwitcher />

        <PrimaryNav items={nav} projectId={projectId} />

        {/* Overflow nav (Task: mobile nav is otherwise unreachable) — the SAME
            role-gated `nav` array, rendered as a Radix dropdown. CSS-only
            visibility: hidden above the breakpoint where .shell__nav hides,
            shown below it, so there is never a gap or a double nav. */}
        <OverflowNav items={nav} projectId={projectId} />

        <button
          type="button"
          className="shell__search"
          aria-label="Search everything (Command K)"
          onClick={() => setPaletteOpen(true)}
        >
          <span className="shell__search-icon" aria-hidden="true">
            ⌕
          </span>
          <span className="shell__search-label">Search</span>
          <kbd className="shell__search-kbd" aria-hidden="true">
            {SHORTCUT_LABEL}
          </kbd>
        </button>

        <div className="shell__spacer" />

        <div className="shell__meta">
          <Notifications />
          <AccountMenu />
        </div>
      </header>

      {/* LD-4: estate-wide, sticks right under the header on every route (the
          service catalog, a console, a request form, Review — all of them)
          instead of surfacing only once a doomed form reaches its last step.
          Text reuses Settings' own state label + the block message's own tail
          clause verbatim (lib/settings.ts's changeFreeze / SettingsAdmin.tsx)
          — never new copy for the same fact. */}
      {frozen && (
        <div className="shell__freeze" role="status">
          <span className="shell__freeze-icon" aria-hidden="true">
            ⚠
          </span>
          <span className="shell__freeze-text">
            <strong>Frozen</strong> — new requests are blocked. Try again once the freeze is
            lifted.
          </span>
          {user.isAdmin && (
            <NavLink
              to={projectScopedPath(projectId, '/admin/settings')}
              className="shell__freeze-link"
            >
              Manage in Settings →
            </NavLink>
          )}
        </div>
      )}

      <main id="main-content" tabIndex={-1} className="shell__main">
        <Suspense fallback={<RouteSkeleton />}>
          <Outlet />
        </Suspense>
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} user={user} />
    </div>
  );
}

export default AppShell;
