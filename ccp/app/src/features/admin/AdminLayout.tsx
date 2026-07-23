import type { JSX } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { PendingChangesBanner } from '@/components/PendingChangesBanner';
import './admin.css';

const TABS = [
  { to: '/admin/users', label: 'Users' },
  { to: '/admin/teams', label: 'Teams' },
  { to: '/admin/policy', label: 'Approval policy' },
  { to: '/admin/risk', label: 'Activity risk' },
  { to: '/admin/settings', label: 'Settings' },
  { to: '/admin/history', label: 'History' },
  { to: '/admin/projects', label: 'Projects' },
  { to: '/admin/pending-changes', label: 'Pending changes' },
];

/** Lead-only governance hub: accounts, team → service ownership, and the risk-based approval policy. */
export function AdminLayout(): JSX.Element {
  return (
    <div className="admin">
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Admin' }]} />

      <header className="admin__header">
        <p className="page-eyebrow">Governance</p>
        <h1 className="admin__title">Admin</h1>
        <p className="admin__sub">
          Govern the control plane — accounts, team ownership, and how many approvals a change needs.
        </p>
      </header>

      {/* App-wide within the admin area (admins-only by construction — this
          whole layout is behind AdminGate): every admin tab shows it, not just
          the Pending changes tab itself. */}
      <PendingChangesBanner />

      <nav className="admin__tabs" aria-label="Admin sections">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            className={({ isActive }) => (isActive ? 'admin__tab admin__tab--active' : 'admin__tab')}
          >
            {t.label}
          </NavLink>
        ))}
      </nav>

      <div className="admin__panel">
        <Outlet />
      </div>
    </div>
  );
}

export default AdminLayout;
