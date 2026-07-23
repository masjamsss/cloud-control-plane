import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from '../appEnv';
import type { AccountItem } from '../store/schema';
import type { RoleName } from '../store/schema';
import { apiError } from '../errors';
import { failCode } from './session';
import { isBoundToProject, projectsOf, roleFor } from '../projects';
import { record } from '../domain/audit';

function requireAccount(c: Parameters<MiddlewareHandler<AppEnv>>[0]): AccountItem | Response {
  const account = c.get('account');
  if (!account) {
    const fail = c.get('sessionFail');
    return apiError(c, fail ? failCode(fail) : 'NO_SESSION');
  }
  return account;
}

/**
 * Role gate, now PER PROJECT: reads the caller's role ON the acting project
 * (`roleFor(account, projectId)`), not the old single global `account.role`. Always
 * mounted under `withProject` (projectId set) and, on the request/registry groups,
 * under `requireProjectMembership` — but it fails closed on its own too: a non-member
 * resolves to `undefined`, which is in no `roles` list → FORBIDDEN_ROLE.
 */
export function requireRole(...roles: RoleName[]): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const account = requireAccount(c);
    if (account instanceof Response) return account;
    const role = roleFor(account, c.get('projectId'));
    if (role === undefined || !roles.includes(role)) return apiError(c, 'FORBIDDEN_ROLE');
    await next();
  };
}

/** Admin gate — gates on isAdmin, NEVER role==='lead'. */
export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const account = requireAccount(c);
  if (account instanceof Response) return account;
  if (account.isAdmin !== true) return apiError(c, 'NOT_ADMIN');
  await next();
};

/**
 * Account↔project authorization binding (CRITICAL-latent).
 * `withProject` only checks the project id EXISTS; this gate checks the CALLING
 * ACCOUNT is bound to it (`roles`/`projects` on the account via `isBoundToProject`;
 * `'*'` = all projects, incl. the reserved `@control` scope; a bare legacy row is
 * now a member of NOTHING — fail closed, data-birth spec §5, `projects.ts#rolesOf`
 * arm 3). Mounted on every project-scoped route group (requests, admin, migrate),
 * so submit/approve/reject/read/config under project P all refuse an unbound
 * account with 403 PROJECT_SCOPE. The denial is appended to the TARGET project's
 * audit chain (same pattern as failed-login auditing in auth.ts) so a tenant sees
 * who tried.
 */
export const requireProjectMembership: MiddlewareHandler<AppEnv> = async (c, next) => {
  const account = requireAccount(c);
  if (account instanceof Response) return account;
  const projectId = c.get('projectId');
  if (!isBoundToProject(account, projectId)) {
    await record(c.get('store'), projectId, {
      action: 'project-scope-denied',
      actor: account.id,
      targetType: 'project',
      targetId: projectId,
      after: { path: c.req.path, method: c.req.method, boundTo: projectsOf(account) },
    });
    return apiError(c, 'PROJECT_SCOPE');
  }
  await next();
};
