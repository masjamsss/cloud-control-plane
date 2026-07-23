import type { AccountItem, RoleBinding, RoleName } from '../store/schema';
import { projectsOf, roleFor, rolesOf, teamFor } from '../projects';
import { totpDevicesOf } from './totp';

/** The public Account projection — credential material NEVER serializes. */
export type PublicAccount = {
  id: string;
  username: string;
  displayName: string;
  /** The role RESOLVED for the acting project (back-compat for single-project clients).
   * The authoritative per-project truth is `roles` below. */
  role: RoleName;
  /** The team RESOLVED for the acting project. */
  teamId: string;
  status: 'active' | 'disabled';
  isAdmin: boolean;
  /** Derived legacy membership list (the key set of `roles`) — kept so existing
   * single-project clients that read `projects` keep working. */
  projects: string[];
  /** The authoritative per-project authorization map (new field; ignored by the
   * current app's narrower `User` type, consumed by the future per-project client). */
  roles: Record<string, RoleBinding>;
  mustChangePassword: boolean;
  totpEnrolled: boolean;
  /** Admin-set 2FA override: `undefined` = use the role default. The Admin
   * Users screen reads this to render the per-user "2FA required" control. */
  totpRequired?: boolean;
  createdAt: string;
  createdBy: string;
};

/**
 * The public projection, RESOLVED for the acting `projectId`. `role`/`teamId` are the
 * account's values on that project (or, if it is not a member of the acting project, a
 * representative entry — the `'*'` binding or the first — so a legacy single-project
 * client never sees `undefined`); `roles` carries the authoritative per-project map and
 * `projects` its key set. Credential material never serializes.
 */
export function publicAccount(a: AccountItem, projectId: string): PublicAccount {
  const roles = rolesOf(a);
  // Prefer the acting project's binding; else '*'; else any entry — never undefined,
  // so the legacy scalar `role`/`teamId` stay populated for single-project clients.
  const resolved =
    roles[projectId] ?? roles['*'] ?? Object.values(roles)[0] ?? { role: 'requester' as RoleName };
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: resolved.role,
    teamId: resolved.teamId ?? '',
    status: a.status,
    isAdmin: a.isAdmin,
    projects: projectsOf(a),
    roles,
    mustChangePassword: a.mustChangePassword,
    // Reads the ADR-0024 shim — same truth value as `a.totp !== undefined` for
    // every existing row, but honest once a self-service device mutation has
    // materialized (or emptied) `totpDevices`.
    totpEnrolled: totpDevicesOf(a).length > 0,
    ...(a.totpRequired !== undefined ? { totpRequired: a.totpRequired } : {}),
    createdAt: a.createdAt,
    createdBy: a.createdBy,
  };
}

/** The `User` shape the app's pure permission fns expect (types/user.ts). */
export type AppUser = { id: string; name: string; role: RoleName; teamId: string; isAdmin: boolean };

/**
 * The `User` a downstream permission check sees, RESOLVED for `projectId` — so
 * `User.role`/`User.teamId` ARE the per-project values and every pure permission fn
 * (`canRequest`/`canApprove`) keeps its signature. Only ever called after
 * `requireProjectMembership`, so `roleFor` is defined; the `?? 'requester'` / `?? ''`
 * floor is a fail-closed belt-and-braces for a non-member (least privilege, no team).
 */
export function toUser(a: AccountItem, projectId: string): AppUser {
  return {
    id: a.id,
    name: a.displayName,
    role: roleFor(a, projectId) ?? 'requester',
    teamId: teamFor(a, projectId) ?? '',
    isAdmin: a.isAdmin,
  };
}
