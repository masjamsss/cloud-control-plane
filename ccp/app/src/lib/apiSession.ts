import type { Role } from '@/types';
import type { Account } from '@/lib/accounts';
import type { AuthAccount, RoleScopeBinding } from '@/lib/httpApi';
import { currentProjectId } from '@/lib/projectScope';
import { createEmitter } from '@/lib/useStore';

/**
 * Is this build wired to a real ccp-api? True when `VITE_API_BASE` is set, so
 * lib/api swapped the in-memory mock for the HTTP client (the ADVISORY →
 * AUTHORITATIVE flip). Kept HERE — a dependency-free module — so lib/auth can
 * branch on it WITHOUT importing lib/api, which imports lib/session → lib/auth
 * (that would be a cycle).
 */
export const isApiMode: boolean = Boolean(import.meta.env.VITE_API_BASE);

/**
 * The api-mode session bridge. In authoritative mode "who is signed in" lives in
 * an httpOnly cookie the browser holds and only ccp-api can read — never in
 * localStorage. But the whole app reads identity synchronously through
 * lib/auth.currentUser(). This module caches the last SERVER-confirmed account
 * (set on login / TOTP / me, cleared on logout) so that synchronous read has an
 * answer in api mode. Mock mode never touches this (lib/auth keeps its local
 * PBKDF2 session there).
 */
// The RAW server projection is cached (not a pre-resolved Account) so that
// role/team can be re-resolved for whichever ACCOUNT (project) the app is
// currently scoped to — switching accounts must change the effective role
// WITHOUT a server round-trip. `role`/`teamId` the server already resolved for
// the header it saw are the fallback when `roles` is absent (single-account/
// legacy backend).
let cached: AuthAccount | null = null;
/** Same-tab write notifications. No storage key backs this module
 * (it's deliberately in-memory-only, per the doc above), so there is no
 * cross-tab signal to compose here — each tab establishes its own api-mode
 * session independently, which is the correct behavior for a server cookie
 * only that tab's requests carry. */
const emitter = createEmitter();
/** Subscribe to this tab's api-session identity changing (set on login/TOTP/me,
 * cleared on logout) — composed into session.ts's useCurrentUser(). */
export const subscribeApiSessionChanged = emitter.subscribe;

/** Resolve the account's binding ON `projectId`: its explicit entry, else the
 * `'*'` all-accounts entry — the same precedence the server's `roleFor` uses.
 * Undefined when the account holds no role on that account (not a member). */
function bindingFor(
  roles: Record<string, RoleScopeBinding> | undefined,
  projectId: string,
): RoleScopeBinding | undefined {
  if (!roles) return undefined;
  return roles[projectId] ?? roles['*'];
}

/**
 * The role/team a user holds on a project they have NO binding on.
 *
 * FE-9 — this is an authz decision, so it fails CLOSED. `requester` with no team
 * is the floor the existing permission helpers already read correctly:
 * `canApprove` refuses anything that is not approver/lead, `canRequest` refuses a
 * requester whose team owns no services (and no team owns none), `shellNavItems`
 * hides Approvals, and the manage tier (`lead && isAdmin`) cannot be reached. It
 * is deliberately NOT a new "none" role: adding a fourth role to {@link Role}
 * would make every existing `switch`/lookup table over roles silently incomplete,
 * which is how a fail-open comes back. The floor value composes with the checks
 * that already exist.
 */
const NO_BINDING: { role: Role; teamId: string } = { role: 'requester', teamId: '' };

/**
 * Project the public account ccp-api returns onto the app's {@link Account}
 * shape, RESOLVED for `projectId`.
 *
 * THE RULE: once the server sends a `roles` map, that map is the ONLY authority
 * for role/team — an explicit entry, the `'*'` wildcard, or (no entry) no role
 * here. The scalar `role`/`teamId` the server resolved are read ONLY when there
 * is no map at all, which is the legacy/single-account backend the fallback was
 * written for.
 *
 * It used to be `binding?.role ?? a.role`, which also fired when the map existed
 * and simply had no entry for the active project — so switching to a project the
 * user holds no role on rendered them with whatever role the LOGIN scope had
 * resolved. A lead on `sample` browsing `acme` got lead affordances on `acme`:
 * nav items, approve buttons, drift operator controls. The server re-enforces all
 * of it, so the cost was wrong UI and guaranteed 403s rather than real privilege —
 * but a client authorization model that resolves one scope's role for another
 * scope is a fail-open, and the next reader to trust it is the bug.
 *
 * The same rule covers a binding that carries no `teamId`: the team comes from
 * the binding or is empty, never from the scope the login happened to use.
 *
 * The credential fields (hash/salt/iterations) are server-side only and never
 * read by the UI once signed in, so they carry inert placeholders — this account
 * exists purely to answer currentUser() from the server's own truth.
 */
export function authAccountToAccount(a: AuthAccount, projectId: string): Account {
  const binding = bindingFor(a.roles, projectId);
  const scoped = a.roles
    ? binding
      ? { role: binding.role, teamId: binding.teamId ?? NO_BINDING.teamId }
      : NO_BINDING
    : { role: a.role as Role, teamId: a.teamId };
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: scoped.role,
    teamId: scoped.teamId,
    passwordHash: '',
    salt: '',
    iterations: 0,
    status: a.status,
    createdAt: '',
    createdBy: 'ccp-api',
    mustChangePassword: a.mustChangePassword,
    isAdmin: a.isAdmin,
  };
}

/** Cache the signed-in server account (or clear it with null). */
export function setApiSessionAccount(account: AuthAccount | null): void {
  cached = account;
  emitter.emit();
}

/** The server account this session established, RESOLVED for the ACTIVE account
 * (project) at call time, or null when signed out. Reading it after an account
 * switch reflects the new account's role/team without re-hitting the server. */
export function getApiSessionAccount(): Account | null {
  return cached ? authAccountToAccount(cached, currentProjectId()) : null;
}

/** The accounts (projects) this signed-in user holds a role on — the key set of
 * the server `roles` map. A `'*'` binding means "every account", surfaced as the
 * wildcard so the switcher can widen to the full registry. Empty when signed out
 * or when the backend served no `roles` map (single-account/legacy). */
export function apiSessionScopes(): string[] {
  return cached?.roles ? Object.keys(cached.roles) : [];
}

/** Drop the cached server account — the local half of an api-mode sign-out. */
export function clearApiSession(): void {
  cached = null;
  recoveryLoginFlag = false;
  emitter.emit();
}

/**
 * A one-shot signal that the CURRENT session was opened via a recovery-code
 * login rather than an ordinary password+device sign-in — the Account page
 * reads it once to nudge "review your devices". Deliberately in-memory only,
 * same as `cached` above: it describes the sign-in that just happened, not a
 * durable account attribute, so a reload dropping it is correct, not a bug.
 */
let recoveryLoginFlag = false;

/** Called once, right after a login response carries `recoveryLogin: true`. */
export function markRecoveryLogin(): void {
  recoveryLoginFlag = true;
}

/** Read-and-clear — the banner shows at most once per sign-in. */
export function consumeRecoveryLoginFlag(): boolean {
  const wasSet = recoveryLoginFlag;
  recoveryLoginFlag = false;
  return wasSet;
}
