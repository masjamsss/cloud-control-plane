import { lazy, Suspense } from 'react';
import type { JSX } from 'react';
import { Navigate, createBrowserRouter, useLocation, useParams } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { RouteError } from '@/components/RouteError';
import { NotFound } from '@/components/NotFound';
import { RouteSkeleton } from '@/components/RouteSkeleton';
import { AdminGate, RequireAuth, RoleGate } from '@/components/guards';
import { LoginPage } from '@/features/auth/LoginPage';
import { ServiceCatalog } from '@/features/catalog/ServiceCatalog';
import { ServiceConsole } from '@/features/services/ServiceConsole';
import { ResourceDetail } from '@/features/services/ResourceDetail';
import { RequestForm } from '@/features/request/RequestForm';
import { BulkRequestForm } from '@/features/request/BulkRequestForm';
import { BeyondCatalogForm } from '@/features/request/BeyondCatalogForm';
import { ProvisionService } from '@/features/request/ProvisionService';
import { MyRequests } from '@/features/requests/MyRequests';
import { RequestDetail } from '@/features/requests/RequestDetail';
import { NotInControlPlane } from '@/features/help/NotInControlPlane';
import { ApprovalsQueue } from '@/features/approvals/ApprovalsQueue';
import { LeadDashboard } from '@/features/dashboard/LeadDashboard';
import { DriftPage } from '@/features/drift/DriftPage';
import { AccountSecurityPage } from '@/features/account/AccountSecurityPage';
import { ProjectProvider } from '@/lib/ProjectContext';
import { FIRST_RUN_PATH, legacyPathToProjectPath } from '@/lib/legacyRoute';

export { legacyPathToProjectPath };

// The Lead-only admin subtree is code-split — it's the largest, least-frequently
// visited area, so it need not weigh down the initial bundle. A Suspense boundary
// in AppShell shows a skeleton while the chunk loads.
const AdminLayout = lazy(() => import('@/features/admin/AdminLayout'));
const UsersAdmin = lazy(() => import('@/features/admin/UsersAdmin'));
const TeamsAdmin = lazy(() => import('@/features/admin/TeamsAdmin'));
const ApprovalPolicyAdmin = lazy(() => import('@/features/admin/ApprovalPolicyAdmin'));
const RiskAdmin = lazy(() => import('@/features/admin/RiskAdmin'));
const SettingsAdmin = lazy(() => import('@/features/admin/SettingsAdmin'));
const AuditHistory = lazy(() => import('@/features/admin/AuditHistory'));
const ProjectsAdmin = lazy(() => import('@/features/admin/ProjectsAdmin'));
const PendingChanges = lazy(() => import('@/features/admin/PendingChanges'));
// The first-run / "onboard your estate" surface (data-birth spec, lane B
// item 3): a top-level page, NOT nested under `/p/:projectId` — it exists
// precisely for the moment no estate is scoped yet, so it renders outside
// ProjectProvider (own Suspense boundary; AppShell's does not reach here).
const FirstRunPage = lazy(() => import('@/features/onboarding/FirstRunPage'));

/**
 * Layout element for `/p/:projectId`: resolves the route param and
 * sets the project scope (ProjectProvider) BEFORE any child renders, then
 * gates on auth exactly as before multi-project (RequireAuth wraps AppShell).
 * An unknown project id throws inside ProjectProvider's render, which this
 * route's errorElement (RouteError) catches — "No project named X".
 */
function ProjectRoute(): JSX.Element {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <ProjectProvider projectId={projectId}>
      <RequireAuth>
        <AppShell />
      </RequireAuth>
    </ProjectProvider>
  );
}

/**
 * Every path (no `/p/:projectId` prefix) — an old bookmark, a NavLink's
 * absolute `to`, or a raw deep link — redirects into whichever project is
 * currently scoped, preserving the search/hash so e.g. a resource action's
 * `?target=` survives the hop. Nothing scoped yet on a fresh load lands on a
 * concrete estate the account already holds a role on, the bundled sample
 * (mock/standalone), or the first-run surface — never a guessed sample id
 * (`lib/legacyRoute.ts`'s `unscopedLandingPath`).
 */
function LegacyRedirect(): JSX.Element {
  const location = useLocation();
  const target = legacyPathToProjectPath(location.pathname) + location.search + location.hash;
  return <Navigate to={target} replace />;
}

/**
 * Flat, service-first navigation (CONCEPT.md), mounted under `/p/:projectId`
 * so the same build serves any number of imported projects. `/login`
 * is public; everything else lives behind RequireAuth in the AppShell.
 * Senior-only areas (Approvals, Dashboard, Users) are gated at the route, not
 * just hidden in the nav.
 *
 * Each route carries a `handle.title` — AppShell reads it via useMatches to set
 * document.title. A thrown error in the shell subtree renders RouteError; an
 * unmatched path within a known project renders the styled NotFound inside the
 * shell; a path with no `/p/:projectId` prefix at all redirects via
 * LegacyRedirect so every deep link still lands somewhere real.
 */
export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, handle: { title: 'Sign in' } },
  {
    // The first-run / "onboard your estate" surface — reached when nothing
    // is scoped and the signed-in account holds no concrete estate role
    // either (lib/legacyRoute.ts `unscopedLandingPath`). Deliberately a
    // sibling of `/p/:projectId`, not a child: it exists for the state where
    // there is no `:projectId` to have.
    path: FIRST_RUN_PATH,
    element: (
      <RequireAuth>
        <Suspense fallback={<RouteSkeleton />}>
          <FirstRunPage />
        </Suspense>
      </RequireAuth>
    ),
    handle: { title: 'Get started' },
  },
  {
    path: '/p/:projectId',
    element: <ProjectRoute />,
    errorElement: <RouteError />,
    children: [
      { index: true, element: <ServiceCatalog />, handle: { title: 'Services' } },
      {
        // A literal path — React Router v6 ranks static segments above dynamic
        // ones, so this always wins over services/:service regardless of order,
        // but it is listed first for readability (the beyond-catalog
        // escape hatch, not a manifest-driven service).
        path: 'services/request-new',
        element: <BeyondCatalogForm />,
        handle: { title: 'Request something new' },
      },
      {
        path: 'services/:service',
        element: <ServiceConsole />,
        handle: { title: 'Service' },
      },
      {
        // Provision pages for the provider-wide catalog: pick a
        // resource type, then a schema-generated form (or the estate's own
        // hand-authored form where one exists). A literal `provision` segment,
        // so it never collides with services/:service.
        path: 'provision/:service',
        element: <ProvisionService />,
        handle: { title: 'Provision' },
      },
      {
        // A literal `resources` segment — React Router ranks static above
        // dynamic, and this 4-segment path can't collide with the 3-segment
        // operation route below regardless. The resourceId is a url-encoded
        // inventory address (all bundled addresses are [A-Za-z0-9_.-] only).
        path: 'services/:service/resources/:resourceId',
        element: <ResourceDetail />,
        handle: { title: 'Resource' },
      },
      {
        // Bulk change (Phase B): one op fanned across many selected targets. A literal
        // `bulk` segment — ranks above the dynamic operation route, and the 4-segment shape
        // can't collide with it. The `?targets=` query carries the selected addresses.
        path: 'services/:service/bulk/:operationId',
        element: <BulkRequestForm />,
        handle: { title: 'Bulk change' },
      },
      {
        path: 'services/:service/:operationId',
        element: <RequestForm />,
        handle: { title: 'Request a change' },
      },
      { path: 'requests', element: <MyRequests />, handle: { title: 'My requests' } },
      { path: 'requests/:id', element: <RequestDetail />, handle: { title: 'Request' } },
      {
        // The out-of-tool boundary page: the honest answer for
        // ticket work that is not a Terraform change. Reached from the
        // command palette ("reboot", "run backup now", "restore"…).
        path: 'not-in-control-plane',
        element: <NotInControlPlane />,
        handle: { title: 'Not in the Control Plane' },
      },
      {
        // Open to every bound role, unlike Approvals/Dashboard below —
        // presence is honesty (a Requester must see that a resource they're
        // about to request against has drifted); the api/mock project the
        // response so a Requester never receives values or security
        // evidence, never gated here at the route.
        path: 'drift',
        element: <DriftPage />,
        handle: { title: 'Drift' },
      },
      {
        // Self-service identity: password, authenticator devices, recovery
        // codes, active sessions. Open to EVERY signed-in account regardless
        // of role — this is not an admin surface and carries no gating
        // wrapper, and every action it drives operates on the signed-in
        // account only.
        path: 'account',
        element: <AccountSecurityPage />,
        handle: { title: 'Account & security' },
      },
      {
        path: 'approvals',
        element: (
          <RoleGate roles={['approver', 'lead']}>
            <ApprovalsQueue />
          </RoleGate>
        ),
        handle: { title: 'Approvals' },
      },
      {
        path: 'dashboard',
        element: (
          <RoleGate roles={['lead']}>
            <LeadDashboard />
          </RoleGate>
        ),
        handle: { title: 'Dashboard' },
      },
      {
        path: 'admin',
        element: (
          <AdminGate>
            <AdminLayout />
          </AdminGate>
        ),
        handle: { title: 'Admin' },
        children: [
          { index: true, element: <Navigate to="/admin/users" replace /> },
          { path: 'users', element: <UsersAdmin />, handle: { title: 'Admin · Users' } },
          { path: 'teams', element: <TeamsAdmin />, handle: { title: 'Admin · Teams' } },
          {
            path: 'policy',
            element: <ApprovalPolicyAdmin />,
            handle: { title: 'Admin · Approval policy' },
          },
          { path: 'risk', element: <RiskAdmin />, handle: { title: 'Admin · Activity risk' } },
          { path: 'settings', element: <SettingsAdmin />, handle: { title: 'Admin · Settings' } },
          { path: 'history', element: <AuditHistory />, handle: { title: 'Admin · History' } },
          { path: 'projects', element: <ProjectsAdmin />, handle: { title: 'Admin · Projects' } },
          {
            path: 'pending-changes',
            element: <PendingChanges />,
            handle: { title: 'Admin · Pending changes' },
          },
        ],
      },
      { path: '*', element: <NotFound />, handle: { title: 'Not found' } },
    ],
  },
  { path: '*', element: <LegacyRedirect />, handle: { title: 'Redirecting…' } },
]);

export default router;
