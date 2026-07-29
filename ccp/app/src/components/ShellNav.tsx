import type { JSX } from 'react';
import { NavLink } from 'react-router-dom';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { projectScopedPath } from '@/lib/legacyRoute';

/**
 * The app's two navigation surfaces (primary shell nav + admin tab bar), in
 * one module, deliberately.
 *
 * UI-3: both were built from UNSCOPED absolute `to` values (`/requests`,
 * `/admin/users`) while the whole shell lives under `/p/:projectId`. React
 * Router resolves `isActive` against the target, so with the location always
 * `/p/<id>/…` NO NavLink was ever active — `.shell__link--active`,
 * `.shell__navmenu-item[aria-current='page']` and `.admin__tab--active` were
 * dead selectors and `aria-current="page"` was never emitted anywhere. Each
 * click also matched the top-level `*` route, unmounting the entire `/p`
 * subtree so `LegacyRedirect` could rewrite the path, then remounting it.
 *
 * They live together because they were the same defect with the same fix, and
 * a shared home is what stops one of them regressing alone — they are also
 * the only two places in the app that must render an ACTIVE state, which is
 * what makes the scoping load-bearing rather than merely tidier.
 */

export interface NavItem {
  to: string;
  label: string;
  end?: boolean;
}

/** Role-gated primary nav. Pure — no hooks, so it is directly testable. */
export function shellNavItems(user: { role: string; isAdmin?: boolean }): NavItem[] {
  const canApprove = user.role === 'approver' || user.role === 'lead';
  const isLead = user.role === 'lead';
  return [
    { to: '/', label: 'Home', end: true },
    { to: '/requests', label: 'My requests' },
    // Every role — presence is honesty; the drift page itself projects
    // detail by role, so it is never hidden from the nav like Approvals/
    // Dashboard below.
    { to: '/drift', label: 'Drift' },
    ...(canApprove ? [{ to: '/approvals', label: 'Approvals' }] : []),
    ...(isLead ? [{ to: '/dashboard', label: 'Dashboard' }] : []),
    // Admin is a governance capability, not the Lead role.
    ...(user.isAdmin ? [{ to: '/admin', label: 'Admin' }] : []),
  ];
}

/** The admin area's tab bar contents. */
export const ADMIN_TABS: NavItem[] = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/teams', label: 'Teams' },
  { to: '/admin/policy', label: 'Approval policy' },
  { to: '/admin/risk', label: 'Activity risk' },
  { to: '/admin/settings', label: 'Settings' },
  { to: '/admin/deployment', label: 'Deployment' },
  { to: '/admin/history', label: 'History' },
  { to: '/admin/projects', label: 'Projects' },
  { to: '/admin/pending-changes', label: 'Pending changes' },
];

/** The horizontal primary nav in the shell bar. */
export function PrimaryNav({
  items,
  projectId,
}: {
  items: NavItem[];
  projectId: string;
}): JSX.Element {
  return (
    <nav className="shell__nav" aria-label="Primary">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={projectScopedPath(projectId, item.to)}
          end={item.end}
          className={({ isActive }) => (isActive ? 'shell__link shell__link--active' : 'shell__link')}
        >
          {item.label}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * Overflow nav (mobile) — the same items, rendered as a Radix dropdown.
 * NavLink's className stays a plain string here (not the isActive-callback
 * form used above) so Radix's asChild/Slot prop merge — which only knows how
 * to combine string classNames — stays safe; the current route is still
 * indicated via NavLink's own `aria-current="page"`, targeted in CSS.
 */
export function OverflowNav({
  items,
  projectId,
}: {
  items: NavItem[];
  projectId: string;
}): JSX.Element {
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="shell__nav-toggle" aria-label="Open navigation menu">
        <span aria-hidden="true">☰</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="shell__navmenu" align="start" sideOffset={8}>
          {items.map((item) => (
            <DropdownMenu.Item key={item.to} asChild>
              <NavLink
                to={projectScopedPath(projectId, item.to)}
                end={item.end}
                className="shell__navmenu-item"
              >
                {item.label}
              </NavLink>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** The admin area's tab bar. */
export function AdminTabs({ projectId }: { projectId: string }): JSX.Element {
  return (
    <nav className="admin__tabs" aria-label="Admin sections">
      {ADMIN_TABS.map((t) => (
        <NavLink
          key={t.to}
          to={projectScopedPath(projectId, t.to)}
          className={({ isActive }) => (isActive ? 'admin__tab admin__tab--active' : 'admin__tab')}
        >
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
