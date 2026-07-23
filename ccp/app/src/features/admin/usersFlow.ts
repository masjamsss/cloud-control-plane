import type { Role, Team } from '@/types';
import type {
  AccountDeleteResult,
  AdminAccount,
  AdminWriteOutcome,
  CreateAccountOutcome,
  HttpApiClient,
  SessionRevokeResult,
  TotpResetResult,
} from '@/lib/httpApi';
import {
  enroll,
  listAccounts,
  removeAccount,
  resetAccountTotp,
  resetPassword,
  revokeAccountSessions,
  setDisplayName,
  setRole,
  setStatus,
  setTeam,
  setTotpRequired,
  type Account,
  type EnrollInput,
} from '@/lib/accounts';
import { getTeams } from '@/lib/teams';

/**
 * Users admin's ADVISORY → AUTHORITATIVE branch (B1).
 * `can('users')` now covers the full accounts CRUD surface — enrol,
 * role/team/status, password-reset — alongside the reset-TOTP/revoke-sessions
 * slice it already carried. The ONE account-mutating control that
 * still reaches lib/accounts's localStorage ONLY, regardless of mode, is the
 * isAdmin grant/revoke toggle — UsersAdmin.tsx keeps that hardcoded-advisory on
 * purpose; there is no server flow that will ever arm it via this module.
 * Pure, React-free so every wired action is unit-testable without mounting
 * UsersAdmin (this repo has no jsdom — see test/standalone.test.ts). EVERY
 * action mirrors teamsFlow.ts's `if (authoritative && client) {...} else
 * {...lib/accounts...}` shape — including reset-TOTP / revoke-sessions / the
 * 2FA-requirement pin, whose local branches act on lib/accounts's demo
 * security state (`totpEnrolled`/`activeSessions`/`totpRequired`), so no
 * Users-admin control is dead in a mock build.
 */

/** admin.ts's `publicAccount` projection, reshaped onto lib/accounts's local
 * `Account` type so UsersAdmin's state/props never have to branch on where a
 * row came from. `passwordHash`/`salt`/`iterations` are LOCAL-ONLY credential
 * storage fields the server never returns (and the UI never reads for a
 * server-sourced row) — left as empty placeholders, same convention
 * advisoryGate.test.ts's own AccountRow fixture already uses. */
function accountFromAdmin(a: AdminAccount): Account {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: a.role,
    teamId: a.teamId,
    // The authoritative per-account role map drives the assignment panel; the
    // server always serves it (an admin-tier read), so it is present in api mode.
    roles: a.roles,
    status: a.status,
    passwordHash: '',
    salt: '',
    iterations: 0,
    createdAt: a.createdAt,
    createdBy: a.createdBy,
    mustChangePassword: a.mustChangePassword,
    isAdmin: a.isAdmin,
    totpRequired: a.totpRequired,
    totpEnrolled: a.totpEnrolled,
  };
}

/** The account list: ccp-api's `GET /admin/accounts` when authoritative
 * (so a write against a row this page shows always targets a REAL server
 * account, never a locally-seeded one the backend has never heard of),
 * else lib/accounts's localStorage — unchanged. */
export async function loadAccountsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
): Promise<Account[]> {
  if (authoritative && client) {
    const remote = await client.listAdminAccounts();
    return remote.map(accountFromAdmin).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  return listAccounts();
}

export async function enrollVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  input: EnrollInput,
  byId: string,
): Promise<CreateAccountOutcome> {
  if (authoritative && client) {
    return client.createAdminAccount(input);
  }
  const account = await enroll(input, byId);
  return { applied: true, account: accountToAdmin(account) };
}

function accountToAdmin(a: Account): AdminAccount {
  return {
    id: a.id,
    username: a.username,
    displayName: a.displayName,
    role: a.role,
    teamId: a.teamId,
    status: a.status,
    isAdmin: a.isAdmin === true,
    mustChangePassword: a.mustChangePassword === true,
    totpEnrolled: a.totpEnrolled === true, // the demo enrolment state (lib/accounts)
    ...(a.totpRequired !== undefined ? { totpRequired: a.totpRequired } : {}),
    createdAt: a.createdAt,
    createdBy: a.createdBy,
  };
}

export async function setAccountRoleVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  role: Role,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.setAccountRole(id, role);
  setRole(id, role);
  return { applied: true };
}

export async function setAccountTeamVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  teamId: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.setAccountTeam(id, teamId);
  setTeam(id, teamId);
  return { applied: true };
}

export async function setAccountStatusVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  status: Account['status'],
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.setAccountStatus(id, status);
  setStatus(id, status);
  return { applied: true };
}

export async function resetAccountPasswordVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  newPassword: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.resetAccountPassword(id, newPassword);
  await resetPassword(id, newPassword);
  return { applied: true };
}

/** Rename a user's display name. A non-authorization change: the server applies
 * it immediately (audited); the demo store renames locally. Trimmed here so the
 * demo path and the server see the same value. */
export async function renameAccountVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  displayName: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.renameAccount(id, displayName.trim());
  setDisplayName(id, displayName);
  return { applied: true };
}

/** PERMANENTLY delete an account (Disable stays the reversible option). The
 * server refuses deleting yourself, the last active admin, and the last active
 * lead of any project (fail-closed), and kills the account's live sessions; the
 * demo store mirrors the same guards locally. */
export async function deleteAccountVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  byId: string,
): Promise<AccountDeleteResult> {
  if (authoritative && client) return client.deleteAccount(id);
  removeAccount(id, byId);
  return { ok: true, deleted: true, sessionsRevoked: 0 };
}

/** Success copy for a completed delete, e.g. "@dewi deleted — 2 sessions signed out." */
export function describeAccountDelete(username: string, result: AccountDeleteResult): string {
  return `@${username} deleted — ${pluralSessions(result.sessionsRevoked)} signed out.`;
}

/** Success copy for a dual-controlled account write (api): honest either
 * way — never claims the change took effect when it was actually only
 * proposed for a second admin's ack. `appliedLabel` reads as a past-tense
 * sentence fragment, e.g. `describeAccountWrite(result, 'Role updated')`. */
export function describeAccountWrite(outcome: AdminWriteOutcome, appliedLabel: string): string {
  return outcome.applied
    ? `${appliedLabel}.`
    : `${appliedLabel} — proposed, pending a second admin's approval.`;
}

/* ── multi-account role + scope assignment ───────────────────────────────────
 * A user holds SEVERAL (scope, role) assignments — a role scoped to one account,
 * or to all accounts. "scope" in the UI = which account the role covers. The
 * server enforces the model (per-account verbs, dual-control on a senior grant,
 * per-account last-lead guard, `'*'` only via the sanctioned install path); these
 * helpers are pure plumbing over the client verbs so the panel stays a thin view
 * and every wired action is unit-testable without a DOM. */

/** The wildcard scope: a role that covers EVERY account. Set at first install,
 * never granted through this panel (the server refuses a `'*'` verb target). */
export const ALL_ACCOUNTS_SCOPE = '*';
/** Plain-language label for the wildcard scope — the operator never sees `'*'`. */
export const ALL_ACCOUNTS_LABEL = 'All accounts';
/** Why the wildcard can't be granted/removed here (shown when it is chosen). */
export const ALL_ACCOUNTS_NOTE =
  'An all-accounts role is set up when the account is first installed, not from this screen.';

/** One (scope, role) the user holds. `scope` is an account id or `'*'`. */
export interface Assignment {
  scope: string;
  role: Role;
  teamId?: string;
}

/** An account the user could be assigned a role on — the scope dropdown's option. */
export interface ScopeOption {
  id: string;
  name: string;
}

/** A senior role is one that carries approval power — granting/raising to it is
 * dual-controlled server-side (the panel surfaces "pending a second admin's
 * approval"). A plain requester grant, a team change, and a revoke apply now. */
export function isSeniorRole(role: Role): boolean {
  return role !== 'requester';
}

/** The user's current assignments, newest-model first. In api mode this is the
 * server `roles` map; on a mock/demo row (no map) it degrades to the single
 * scalar role on the active account, so the panel still shows one honest row.
 * `'*'` sorts first (it is the widest scope), then account ids alphabetically. */
export function assignmentsOf(account: Account, activeProjectId: string): Assignment[] {
  const roles = account.roles;
  if (roles && Object.keys(roles).length > 0) {
    return Object.entries(roles)
      .map(([scope, b]) => ({ scope, role: b.role, ...(b.teamId ? { teamId: b.teamId } : {}) }))
      .sort((a, b) => {
        if (a.scope === ALL_ACCOUNTS_SCOPE) return -1;
        if (b.scope === ALL_ACCOUNTS_SCOPE) return 1;
        return a.scope.localeCompare(b.scope);
      });
  }
  return [{ scope: activeProjectId, role: account.role, ...(account.teamId ? { teamId: account.teamId } : {}) }];
}

/** The plain-language name for a scope: "All accounts" for the wildcard, else the
 * registered account's name (falling back to its id if it isn't in the option set). */
export function scopeLabelFor(scope: string, scopes: ScopeOption[]): string {
  if (scope === ALL_ACCOUNTS_SCOPE) return ALL_ACCOUNTS_LABEL;
  return scopes.find((s) => s.id === scope)?.name ?? scope;
}

/**
 * The accounts an admin can assign a role on — the scope dropdown's options.
 * Api mode: every REGISTERED, ready account (a valid server binding target),
 * with the acting account always included so it is never missing. Demo/mock:
 * just the acting account (the local store is single-account). Never includes the
 * `'*'` wildcard — the UI appends that as its own labelled option.
 */
export async function loadAssignableScopesVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  active: ScopeOption,
): Promise<ScopeOption[]> {
  if (!(authoritative && client)) return [active];
  const projects = await client.listServerProjects();
  const ready = projects.filter((p) => p.status === 'ready').map((p) => ({ id: p.id, name: p.name }));
  const byId = new Map<string, ScopeOption>();
  byId.set(active.id, active); // the acting account is always assignable
  for (const p of ready) if (!byId.has(p.id)) byId.set(p.id, p);
  return [...byId.values()];
}

/** The teams available for a chosen scope (teams are PER account). Api mode reads
 * that account's team list; demo reads the local teams. The wildcard scope has no
 * team dimension, so it resolves to an empty list. */
export async function loadTeamsForScopeVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  scope: string,
): Promise<Team[]> {
  if (scope === ALL_ACCOUNTS_SCOPE) return [];
  if (authoritative && client) {
    const teams = await client.listAdminTeams({ projectId: scope });
    return teams.map((t) => ({ id: t.id, name: t.name, serviceSlugs: t.serviceSlugs }));
  }
  return getTeams();
}

/** Add (or raise) a role for the user on ONE account. A grant/raise to a senior
 * role is dual-controlled server-side → `{applied:false}` ("pending a second
 * admin's approval"); a requester grant applies immediately. The local demo
 * store has no per-account model, so it sets the single scalar role instead. */
export async function addAssignmentVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  scope: string,
  role: Role,
  teamId?: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.setAccountRoleOn(id, scope, role, teamId);
  setRole(id, role);
  if (teamId !== undefined) setTeam(id, teamId);
  return { applied: true };
}

/** Change the team on an existing assignment (immediate — team is not a privilege
 * dimension). Scoped to the chosen account server-side. */
export async function setAssignmentTeamVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  scope: string,
  teamId: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.setAccountTeamOn(id, scope, teamId);
  setTeam(id, teamId);
  return { applied: true };
}

/** Remove (revoke) the user's role on ONE account. Immediate, but blocked
 * server-side by the per-account last-lead guard (you cannot strand an account
 * with no active lead). The local demo store is single-scalar with no revoke,
 * so it no-ops there. */
export async function removeAssignmentVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  id: string,
  scope: string,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.revokeAccountRoleOn(id, scope);
  return { applied: true };
}

/** The account's role ON a scope, resolved the same way the server does: the
 * explicit entry, else the `'*'` all-accounts entry, else (no map — a demo row)
 * the single scalar role. Undefined = not a member there. */
function roleOn(account: Account, scope: string): Role | undefined {
  const roles = account.roles;
  if (roles) return (roles[scope] ?? roles[ALL_ACCOUNTS_SCOPE])?.role;
  return account.role;
}

/**
 * Why an assignment's Remove is blocked — or `null` when removing is allowed.
 * Mirrors the server's fail-closed rules so the control is disabled WITH a
 * plain reason up front, instead of a click that bounces off a 422:
 *   · the `'*'` all-accounts entry is install-time, never removed here;
 *   · the last lead on an account can't be removed (the server's per-account
 *     last-lead guard — counted across every user, `'*'` leads included).
 * The server still enforces both; this only decides what the control says.
 */
export function blockedRemoveReason(
  target: Account,
  assignment: Assignment,
  accounts: Account[],
  scopes: ScopeOption[],
): string | null {
  if (assignment.scope === ALL_ACCOUNTS_SCOPE) return ALL_ACCOUNTS_NOTE;
  if (assignment.role !== 'lead') return null;
  // No directory to count against (a bare render) → no up-front verdict; the
  // server's guard still answers if the removal really would strand the account.
  if (accounts.length === 0) return null;
  const otherActiveLeads = accounts.filter(
    (a) => a.id !== target.id && a.status === 'active' && roleOn(a, assignment.scope) === 'lead',
  ).length;
  if (otherActiveLeads > 0) return null;
  return `Can't remove the last lead on ${scopeLabelFor(assignment.scope, scopes)} — assign another lead first.`;
}

/* ── admin-controlled 2FA requirement ──────────────────────── */

/** The EFFECTIVE per-user 2FA requirement — the app mirror of the server's
 * `auth/totp.ts#needsTotp`. An admin-set `totpRequired` wins outright; otherwise
 * the role default applies (approver/lead OR any admin). Kept as a tiny pure
 * function (no cross-package import — the api/app boundary rule) so it drives the
 * control's rendered state and stays unit-testable without a DOM. */
export function isPrivilegedAccount(a: { role: Role; isAdmin?: boolean }): boolean {
  return a.role !== 'requester' || a.isAdmin === true;
}
export function effectiveTotpRequired(a: { role: Role; isAdmin?: boolean; totpRequired?: boolean }): boolean {
  return a.totpRequired ?? isPrivilegedAccount(a);
}

/** The UI-only guard rail: turning 2FA OFF for a privileged account is a security
 * downgrade, so the screen must warn + confirm before it takes effect. The server
 * permits + audits the change regardless (no role floor) — this only decides
 * whether the extra confirm step is shown. */
export function needsTotpDowngradeConfirm(a: { role: Role; isAdmin?: boolean }, next: boolean): boolean {
  return next === false && isPrivilegedAccount(a);
}

/** Pin an account's 2FA requirement true/false: PATCH the server record when
 * authoritative, else pin it on the demo account store — the same value
 * `effectiveTotpRequired` renders from either way. */
export async function setAccountTotpRequiredVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  accountId: string,
  required: boolean,
): Promise<AdminWriteOutcome> {
  if (authoritative && client) return client.setAccountTotpRequired(accountId, required);
  setTotpRequired(accountId, required);
  return { applied: true };
}

/* ── reset-TOTP / revoke-sessions — server actions with demo stand-ins ──────── */

/** Clear an account's authenticator (and, server-parity, its sessions):
 * ccp-api's reset-totp route when authoritative, else the demo security
 * state on lib/accounts — both answer the same result shape. */
export async function resetAccountTotpVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  accountId: string,
): Promise<TotpResetResult> {
  if (authoritative && client) return client.resetAccountTotp(accountId);
  const { sessionsRevoked } = resetAccountTotp(accountId);
  return { ok: true, totpReset: true, sessionsRevoked };
}

/** Sign an account out everywhere — same split as {@link resetAccountTotpVia}. */
export async function revokeAccountSessionsVia(
  authoritative: boolean,
  client: HttpApiClient | null,
  accountId: string,
): Promise<SessionRevokeResult> {
  if (authoritative && client) return client.revokeAccountSessions(accountId);
  const { sessionsRevoked } = revokeAccountSessions(accountId);
  return { ok: true, sessionsRevoked };
}

function pluralSessions(n: number): string {
  return `${n} session${n === 1 ? '' : 's'}`;
}

export function describeTotpReset(result: TotpResetResult): string {
  return `2FA reset — ${pluralSessions(result.sessionsRevoked)} revoked.`;
}

export function describeSessionsRevoked(result: SessionRevokeResult): string {
  return `${pluralSessions(result.sessionsRevoked)} revoked.`;
}
