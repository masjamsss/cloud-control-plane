import type { JSX } from 'react';
import { Navigate } from 'react-router-dom';
import type { Role } from '@/types';
import { useAuthedAccount } from '@/lib/auth';

/**
 * Gate the whole app shell: no session → the login page. An account still on a temporary
 * password (mustChangePassword) is bounced to the login page too, where it is forced to
 * set a new one — so the documented default cannot reach any route.
 *
 * FE-5: all three guards read the SUBSCRIBED account. They used the unsubscribed
 * `currentUser()`, which answers with whatever was true at the last render and never says
 * it changed — so an expired session kept rendering the app indefinitely, and a cross-tab
 * sign-out was invisible for the same reason. `httpApi` clears the session cache on a
 * session-class 401; this is what turns that clear into a redirect.
 */
export function RequireAuth({ children }: { children: JSX.Element }): JSX.Element {
  const user = useAuthedAccount();
  if (!user || user.mustChangePassword) return <Navigate to="/login" replace />;
  return children;
}

/** Gate a route to certain roles; a wrong role is sent home (nav already hides it). */
export function RoleGate({
  roles,
  children,
}: {
  roles: Role[];
  children: JSX.Element;
}): JSX.Element {
  const user = useAuthedAccount();
  if (!user) return <Navigate to="/login" replace />;
  if (!roles.includes(user.role)) return <Navigate to="/" replace />;
  return children;
}

/** Gate the admin area on the admin capability, not on the Lead role —
 * governance power is separate from approval power. */
export function AdminGate({ children }: { children: JSX.Element }): JSX.Element {
  const user = useAuthedAccount();
  if (!user) return <Navigate to="/login" replace />;
  if (!user.isAdmin) return <Navigate to="/" replace />;
  return children;
}
