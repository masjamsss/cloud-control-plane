import type { JSX } from 'react';
import { Outlet } from 'react-router-dom';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { PendingChangesBanner } from '@/components/PendingChangesBanner';
import { AdminTabs } from '@/components/ShellNav';
import { useActiveProjectId } from '@/lib/ProjectContext';
import './admin.css';

/** Lead-only governance hub: accounts, team → service ownership, and the risk-based approval policy. */
export function AdminLayout(): JSX.Element {
  // UI-3: the tab bar's targets must be project-scoped, or `isActive` never
  // fires and `.admin__tab--active` is dead code.
  const projectId = useActiveProjectId();
  return (
    <div className="admin">
      <Breadcrumbs items={[{ label: 'Home', to: '/' }, { label: 'Admin' }]} />

      <header className="admin__header">
        <p className="page-eyebrow">Governance</p>
        <h1 className="admin__title">Admin</h1>
        <p className="admin__sub">
          Govern the control plane — accounts, team ownership, and how many approvals a change
          needs.
        </p>
      </header>

      {/* App-wide within the admin area (admins-only by construction — this
          whole layout is behind AdminGate): every admin tab shows it, not just
          the Pending changes tab itself. */}
      <PendingChangesBanner />

      <AdminTabs projectId={projectId} />

      <div className="admin__panel">
        <Outlet />
      </div>
    </div>
  );
}

export default AdminLayout;
